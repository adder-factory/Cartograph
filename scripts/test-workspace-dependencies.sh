#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'workspace dependency contract failed: %s\n' "$1" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || fail 'python3 with tomllib is required'

python3 - "$ROOT" <<'PY'
import json
import subprocess
import sys
import tomllib
from pathlib import Path


DEPENDENCY_TABLES = ("dependencies", "dev-dependencies", "build-dependencies")


def fail(message: str) -> None:
    print(f"workspace dependency contract failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_toml(path: Path, label: str) -> dict:
    try:
        with path.open("rb") as source:
            document = tomllib.load(source)
    except (OSError, tomllib.TOMLDecodeError) as error:
        fail(f"{label} is not valid readable TOML: {error}")
    if not isinstance(document, dict):
        fail(f"{label} did not parse as a TOML table")
    return document


def dependency_violations(document: dict) -> list[str]:
    violations: list[str] = []

    def inspect_tables(owner: str, tables: object) -> None:
        if tables is None:
            return
        if not isinstance(tables, dict):
            violations.append(f"{owner} is not a dependency table")
            return
        for table_name in DEPENDENCY_TABLES:
            dependencies = tables.get(table_name)
            if dependencies is None:
                continue
            if not isinstance(dependencies, dict):
                violations.append(f"{owner}.{table_name} is not a table")
                continue
            for dependency_name, dependency in sorted(dependencies.items()):
                if not isinstance(dependency, dict) or dependency.get("workspace") is not True:
                    violations.append(
                        f"{owner}.{table_name}.{dependency_name} must set workspace = true"
                    )

    inspect_tables("manifest", document)
    targets = document.get("target")
    if targets is not None:
        if not isinstance(targets, dict):
            violations.append("manifest.target is not a table")
        else:
            for target_name, target_tables in sorted(targets.items()):
                inspect_tables(f"manifest.target.{target_name}", target_tables)
    return violations


def metadata_member_packages(metadata: dict) -> list[dict]:
    packages = metadata.get("packages")
    member_ids = metadata.get("workspace_members")
    if not isinstance(packages, list) or not isinstance(member_ids, list):
        fail("cargo metadata omitted packages or workspace_members")
    packages_by_id = {
        package.get("id"): package
        for package in packages
        if isinstance(package, dict) and isinstance(package.get("id"), str)
    }
    missing_ids = [member_id for member_id in member_ids if member_id not in packages_by_id]
    if missing_ids:
        fail("cargo metadata omitted a workspace member package")
    return [packages_by_id[member_id] for member_id in member_ids]


def run_parser_regressions() -> None:
    inherited = tomllib.loads(
        """
        [dependencies] # comments and indentation must remain visible
          serde.workspace = true
        [dev-dependencies.tokio]
        workspace = true
        [target.'cfg(unix)'.build-dependencies]
          libc = { workspace = true }
        """
    )
    if dependency_violations(inherited):
        fail("the inherited-dependency positive fixture was rejected")

    direct_dependency_fixtures = {
        "commented header and indented key": """
            [dependencies] # direct dependency
              serde = "1"
        """,
        "top-level dotted key": 'dependencies.serde = "1"',
        "dependency subtable": """
            [dependencies.serde]
            version = "1"
        """,
        "direct dev dependency": """
            [dev-dependencies]
            tempfile = "3"
        """,
        "direct build dependency": """
            [build-dependencies]
            cc = "1"
        """,
        "direct target dependency": """
            [target.'cfg(unix)'.dependencies]
            libc = { path = "../libc" }
        """,
    }
    for fixture_name, fixture in direct_dependency_fixtures.items():
        if not dependency_violations(tomllib.loads(fixture)):
            fail(f"the {fixture_name} negative fixture bypassed the parser")

    metadata_fixture = {
        "workspace_members": ["explicit", "implicit"],
        "packages": [
            {"id": "explicit", "name": "explicit", "manifest_path": "/fixture/a/Cargo.toml"},
            {"id": "implicit", "name": "implicit", "manifest_path": "/fixture/b/Cargo.toml"},
        ],
    }
    selected_names = {
        package["name"] for package in metadata_member_packages(metadata_fixture)
    }
    if selected_names != {"explicit", "implicit"}:
        fail("metadata member enumeration lost an implicit, globbed, or non-literal member")


run_parser_regressions()

root = Path(sys.argv[1]).resolve()
metadata_process = subprocess.run(
    ["cargo", "metadata", "--locked", "--format-version", "1", "--no-deps"],
    cwd=root,
    check=False,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)
if metadata_process.returncode != 0:
    if metadata_process.stderr:
        print(metadata_process.stderr.rstrip(), file=sys.stderr)
    fail("cargo metadata --locked failed")
try:
    metadata = json.loads(metadata_process.stdout)
except json.JSONDecodeError as error:
    fail(f"cargo metadata returned invalid JSON: {error}")

metadata_root = metadata.get("workspace_root")
if not isinstance(metadata_root, str) or Path(metadata_root).resolve() != root:
    fail("cargo metadata resolved a different workspace root")

root_manifest = load_toml(root / "Cargo.toml", "Cargo.toml")
workspace = root_manifest.get("workspace")
if not isinstance(workspace, dict):
    fail("Cargo.toml has no [workspace] table")
workspace_dependencies = workspace.get("dependencies")
if not isinstance(workspace_dependencies, dict) or not workspace_dependencies:
    fail("Cargo.toml has no non-empty [workspace.dependencies] table")

members = metadata_member_packages(metadata)
seen_names: set[str] = set()
for package in members:
    package_name = package.get("name")
    manifest_path_value = package.get("manifest_path")
    if not isinstance(package_name, str) or not isinstance(manifest_path_value, str):
        fail("cargo metadata returned an invalid workspace member")
    if package_name in seen_names:
        fail(f"workspace member name is duplicated: {package_name}")
    seen_names.add(package_name)

    manifest_path = Path(manifest_path_value).resolve()
    try:
        relative_manifest = manifest_path.relative_to(root)
    except ValueError:
        fail(f"workspace member is outside the checkout: {package_name}")
    relative_directory = relative_manifest.parent.as_posix()
    dependency = workspace_dependencies.get(package_name)
    if not isinstance(dependency, dict):
        fail(f"{package_name} is missing from root [workspace.dependencies]")
    if dependency.get("path") != relative_directory:
        fail(
            f"{package_name} must use canonical workspace path {relative_directory}"
        )

    member_document = load_toml(manifest_path, relative_manifest.as_posix())
    violations = dependency_violations(member_document)
    if violations:
        fail(f"{relative_manifest.as_posix()}: {violations[0]}")

print(f"workspace dependency contract passed: {len(members)} member manifests")
PY
