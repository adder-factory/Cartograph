import { hasDependencyName, hasDependencyNameMatching } from './dependency-manifest.js';

const PACKAGE_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'] as const;

export function hasPackageDependency(packageJson: string | null, names: Iterable<string>): boolean {
  return hasDependencyName(packageJson, PACKAGE_DEPENDENCY_FIELDS, names);
}

export function hasPackageDependencyMatching(
  packageJson: string | null,
  predicate: (dependencyName: string) => boolean,
): boolean {
  return hasDependencyNameMatching(packageJson, PACKAGE_DEPENDENCY_FIELDS, predicate);
}
