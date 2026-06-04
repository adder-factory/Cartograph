import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MetadataKey } from '../db/queries-metadata.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import type { QueryBuilder } from '../db/queries.js';
import { getAllFiles, markFilesNeedReextract } from '../db/queries-files.js';
import { clearParseCache, clearParseCacheForFiles } from '../db/queries-parse-cache.js';
import { projectAliasConfigFingerprint } from '../resolution/path-aliases.js';
import type { CartographConfig, FileRecord, Language } from '../types.js';
import { isJsFamily, validatePathWithinRootReal } from '../utils.js';

interface ConfigFingerprintArgs {
  readonly rootDir: string;
  readonly config: CartographConfig;
  readonly hashContent: (content: string) => string;
}

export interface ConfigFingerprintPolicy {
  readonly metadataKey: MetadataKey;
  readonly watchedFiles?: readonly string[];
  readonly fingerprint?: (args: ConfigFingerprintArgs) => string;
  readonly action:
    | {
        readonly kind: 'queue-reextract';
        readonly parseCacheInvalidation:
          | { readonly kind: 'languages'; readonly languages: readonly Language[] }
          | { readonly kind: 'matched-files' };
        readonly shouldReindexFile: (file: FileRecord) => boolean;
      }
    | { readonly kind: 'force-full-scan' };
}

interface SyncInvalidationState {
  filesToIndex: string[];
  changedFilePaths: string[];
  filesChecked: number;
  filesModified: number;
}

export const PATH_ALIAS_CONFIG_FINGERPRINT_POLICY: ConfigFingerprintPolicy = {
  metadataKey: 'path_alias_config_signature',
  fingerprint: ({ rootDir }) => projectAliasConfigFingerprint(rootDir),
  action: {
    kind: 'queue-reextract',
    parseCacheInvalidation: { kind: 'matched-files' },
    shouldReindexFile: (file) => isJsFamily(file.language),
  },
};

export const NESTED_FUNCTION_CONFIG_FINGERPRINT_POLICY: ConfigFingerprintPolicy = {
  metadataKey: 'nested_function_extraction_config_signature',
  fingerprint: ({ config }) =>
    stableConfigFingerprint({
      largeFunctionThreshold: config.largeFunctionThreshold ?? 500,
      nestedPromotionThreshold: config.nestedPromotionThreshold ?? 5,
    }),
  action: {
    kind: 'queue-reextract',
    parseCacheInvalidation: { kind: 'languages', languages: ['typescript', 'javascript', 'tsx', 'jsx'] },
    shouldReindexFile: (file) => isJsFamily(file.language),
  },
};

export const SOURCE_SET_CONFIG_FINGERPRINT_POLICY: ConfigFingerprintPolicy = {
  metadataKey: 'source_set_config_signature',
  fingerprint: ({ config }) =>
    stableConfigFingerprint({
      exclude: config.exclude,
      include: config.include,
      indexSubmodules: config.indexSubmodules ?? true,
      languages: config.languages,
      maxFileSize: config.maxFileSize,
    }),
  action: { kind: 'force-full-scan' },
};

export const EXTRACTION_CONFIG_FINGERPRINT_POLICIES = [
  PATH_ALIAS_CONFIG_FINGERPRINT_POLICY,
  NESTED_FUNCTION_CONFIG_FINGERPRINT_POLICY,
  SOURCE_SET_CONFIG_FINGERPRINT_POLICY,
] as const;

export interface ConfigFingerprintInvalidationPlan {
  readonly forceFullScan: boolean;
  readonly changedPolicies: readonly ConfigFingerprintPolicy[];
  readonly clearParseCacheLanguages: readonly Language[];
  readonly clearParseCacheMatchedFiles: boolean;
  readonly shouldReindexFile: (file: FileRecord) => boolean;
}

interface StampConfigFingerprintsArgs {
  readonly qb: QueryBuilder;
  readonly rootDir: string;
  readonly config: CartographConfig;
  readonly hashContent: (content: string) => string;
  readonly policies?: readonly ConfigFingerprintPolicy[];
}

interface ComputeConfigFingerprintInvalidationPlanArgs {
  readonly qb: QueryBuilder;
  readonly rootDir: string;
  readonly config: CartographConfig;
  readonly hashContent: (content: string) => string;
  readonly policies?: readonly ConfigFingerprintPolicy[];
}

interface ApplyConfigFingerprintInvalidationPlanArgs {
  readonly qb: QueryBuilder;
  readonly rootDir: string;
  readonly state: SyncInvalidationState;
  readonly plan: ConfigFingerprintInvalidationPlan;
}

const EMPTY_INVALIDATION_PLAN: ConfigFingerprintInvalidationPlan = {
  forceFullScan: false,
  changedPolicies: [],
  clearParseCacheLanguages: [],
  clearParseCacheMatchedFiles: false,
  shouldReindexFile: () => false,
};

export function configFingerprint(args: ConfigFingerprintArgs & { policy: ConfigFingerprintPolicy }): string {
  if (args.policy.fingerprint) return args.policy.fingerprint(args);
  return fileConfigFingerprint(args.rootDir, args.policy.watchedFiles ?? [], args.hashContent);
}

function fileConfigFingerprint(
  rootDir: string,
  watchedFiles: readonly string[],
  hashContent: (content: string) => string,
): string {
  return watchedFiles
    .map((fileName) => {
      const filePath = path.join(rootDir, fileName);
      try {
        return `${fileName}:${hashContent(fs.readFileSync(filePath, 'utf8'))}`;
      } catch {
        return `${fileName}:missing`;
      }
    })
    .join('|');
}

function stableConfigFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

export function stampConfigFingerprints(args: StampConfigFingerprintsArgs): void {
  const { qb, rootDir, config, hashContent, policies = EXTRACTION_CONFIG_FINGERPRINT_POLICIES } = args;
  for (const policy of policies) {
    setMetadata(qb, policy.metadataKey, configFingerprint({ rootDir, config, hashContent, policy }));
  }
}

export function computeConfigFingerprintInvalidationPlan(
  args: ComputeConfigFingerprintInvalidationPlanArgs,
): ConfigFingerprintInvalidationPlan {
  const { qb, rootDir, config, hashContent, policies = EXTRACTION_CONFIG_FINGERPRINT_POLICIES } = args;

  const changedPolicies = policies.filter((policy) => {
    const previous = getMetadata(qb, policy.metadataKey);
    const current = configFingerprint({ rootDir, config, hashContent, policy });
    return previous !== current;
  });
  if (changedPolicies.length === 0) return EMPTY_INVALIDATION_PLAN;

  const languages = new Set<Language>();
  const queuePolicies: Array<Extract<ConfigFingerprintPolicy['action'], { kind: 'queue-reextract' }>> = [];
  let forceFullScan = false;
  let clearParseCacheMatchedFiles = false;
  for (const policy of changedPolicies) {
    if (policy.action.kind === 'force-full-scan') {
      forceFullScan = true;
      continue;
    }
    queuePolicies.push(policy.action);
    if (policy.action.parseCacheInvalidation.kind === 'matched-files') {
      clearParseCacheMatchedFiles = true;
    } else {
      for (const language of policy.action.parseCacheInvalidation.languages) languages.add(language);
    }
  }

  return {
    forceFullScan,
    changedPolicies,
    clearParseCacheLanguages: [...languages],
    clearParseCacheMatchedFiles,
    shouldReindexFile: (file) => queuePolicies.some((policy) => policy.shouldReindexFile(file)),
  };
}

export function applyConfigFingerprintInvalidationPlan(args: ApplyConfigFingerprintInvalidationPlanArgs): void {
  const { qb, rootDir, state, plan } = args;
  if (plan.changedPolicies.length === 0) return;
  for (const language of plan.clearParseCacheLanguages) clearParseCache(qb, language);

  const needsReextract: string[] = [];
  const queued = new Set(state.filesToIndex);
  for (const file of getAllFiles(qb)) {
    if (!plan.shouldReindexFile(file)) continue;
    if (!validatePathWithinRootReal(rootDir, file.path)) continue;
    needsReextract.push(file.path);
    if (queued.has(file.path)) continue;
    queued.add(file.path);
    state.filesToIndex.push(file.path);
    state.changedFilePaths.push(file.path);
    state.filesChecked++;
    state.filesModified++;
  }
  if (plan.clearParseCacheMatchedFiles) clearParseCacheForFiles(qb, needsReextract);
  markFilesNeedReextract(qb, needsReextract);
}
