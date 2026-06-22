import { z } from 'zod';
import { asJsonObject, asJsonStringRecord } from './json-object.js';

const packageManifestObjectSchema = z.looseObject({});
const packageNameSchema = z.string().trim().min(1);
const packageVersionSchema = z.string().trim().min(1);
const packageTypeSchema = z.string();
const packageScriptsSchema = z.unknown().transform((value) => asJsonStringRecord(value));

type PackageManifestObject = z.infer<typeof packageManifestObjectSchema>;

function parsePackageManifestObject(raw: string): PackageManifestObject | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const object = asJsonObject(parsed);
  if (!object) return null;
  const result = packageManifestObjectSchema.safeParse(object);
  return result.success ? result.data : null;
}

function ownParsedField<T extends z.ZodType>(
  manifest: PackageManifestObject,
  field: string,
  schema: T,
): z.output<T> | null {
  if (!Object.hasOwn(manifest, field)) return null;
  const result = schema.safeParse(manifest[field]);
  return result.success ? result.data : null;
}

export function readPackageJsonVersion(raw: string): string | null {
  const manifest = parsePackageManifestObject(raw);
  return manifest ? ownParsedField(manifest, 'version', packageVersionSchema) : null;
}

export function readPackageJsonIdentity(raw: string): { name: string | null; version: string | null } {
  const manifest = parsePackageManifestObject(raw);
  if (!manifest) return { name: null, version: null };
  return {
    name: ownParsedField(manifest, 'name', packageNameSchema),
    version: ownParsedField(manifest, 'version', packageVersionSchema),
  };
}

export function packageJsonDeclaresEsm(raw: string): boolean {
  const manifest = parsePackageManifestObject(raw);
  return manifest ? ownParsedField(manifest, 'type', packageTypeSchema) === 'module' : false;
}

export function readPackageJsonScripts(raw: string): Record<string, string> {
  const manifest = parsePackageManifestObject(raw);
  const scripts = manifest ? ownParsedField(manifest, 'scripts', packageScriptsSchema) : null;
  return scripts ?? {};
}
