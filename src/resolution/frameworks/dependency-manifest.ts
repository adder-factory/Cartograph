import { z } from 'zod';
import { asJsonStringRecord } from '../../json-object.js';

const dependencyManifestObjectSchema = z.looseObject({});
const dependencyMapSchema = z.unknown().transform(normalizeDependencyMap);

type DependencyManifestObject = z.infer<typeof dependencyManifestObjectSchema>;
type DependencyMap = Exclude<z.infer<typeof dependencyMapSchema>, undefined>;

function normalizeDependencyMap(value: unknown): Record<string, string> | undefined {
  const deps = asJsonStringRecord(value);
  if (!deps) return undefined;
  return Object.keys(deps).length > 0 ? deps : undefined;
}

function dependencyNamesFromManifest(raw: string | null, fields: Iterable<string>): ReadonlySet<string> {
  const manifest = parseDependencyManifestObject(raw);
  if (!manifest) return new Set();

  const names = new Set<string>();
  for (const field of fields) {
    for (const name of Object.keys(ownDependencyMap(manifest, field))) {
      names.add(name);
    }
  }
  return names;
}

export function hasDependencyName(raw: string | null, fields: Iterable<string>, names: Iterable<string>): boolean {
  const deps = dependencyNamesFromManifest(raw, fields);
  for (const name of names) {
    if (deps.has(name)) return true;
  }
  return false;
}

export function hasDependencyNameMatching(
  raw: string | null,
  fields: Iterable<string>,
  predicate: (dependencyName: string) => boolean,
): boolean {
  for (const name of dependencyNamesFromManifest(raw, fields)) {
    if (predicate(name)) return true;
  }
  return false;
}

function parseDependencyManifestObject(raw: string | null): DependencyManifestObject | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = dependencyManifestObjectSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function ownDependencyMap(manifest: DependencyManifestObject, field: string): DependencyMap {
  if (!Object.hasOwn(manifest, field)) return {};
  const result = dependencyMapSchema.safeParse(manifest[field]);
  return result.success && result.data ? result.data : {};
}
