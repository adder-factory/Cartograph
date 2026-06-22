import { hasDependencyName, hasDependencyNameMatching } from './dependency-manifest.js';

const COMPOSER_DEPENDENCY_FIELDS = ['require', 'require-dev'] as const;

export function hasComposerDependency(composerJson: string | null, names: Iterable<string>): boolean {
  return hasDependencyName(composerJson, COMPOSER_DEPENDENCY_FIELDS, names);
}

export function hasComposerDependencyMatching(
  composerJson: string | null,
  predicate: (dependencyName: string) => boolean,
): boolean {
  return hasDependencyNameMatching(composerJson, COMPOSER_DEPENDENCY_FIELDS, predicate);
}
