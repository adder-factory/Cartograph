use std::{collections::BTreeSet, sync::Arc};

use cartograph_domain::SourceLanguage;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use thiserror::Error;

const MAXIMUM_CONFIGURED_EXCLUDES: usize = 4_096;
const MAXIMUM_EXCLUDE_PATTERN_BYTES: usize = 4_096;
const MAXIMUM_EXCLUDE_TOTAL_BYTES: usize = 4 * 1024 * 1024;

/// Immutable v1.1.33 default exclusions carried into native v2 discovery.
pub const V1_DEFAULT_EXCLUDES: &[&str] = &[
    "**/.git/**",
    "**/node_modules/**",
    "**/vendor/**",
    "**/Pods/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "bin/**",
    "**/obj/**",
    "**/target/**",
    "**/*.min.js",
    "**/*.bundle.js",
    "**/.next/**",
    "**/.nuxt/**",
    "**/.svelte-kit/**",
    "**/.output/**",
    "**/.turbo/**",
    "**/.cache/**",
    "**/.parcel-cache/**",
    "**/.vite/**",
    "**/.astro/**",
    "**/.docusaurus/**",
    "**/.gatsby/**",
    "**/.webpack/**",
    "**/.nx/**",
    "**/.yarn/cache/**",
    "**/.pnpm-store/**",
    "**/storybook-static/**",
    "**/.expo/**",
    "**/web-build/**",
    "**/ios/Pods/**",
    "**/ios/build/**",
    "**/android/build/**",
    "**/android/.gradle/**",
    "**/__pycache__/**",
    "**/.venv/**",
    "**/venv/**",
    "**/site-packages/**",
    "**/dist-packages/**",
    "**/.pytest_cache/**",
    "**/.mypy_cache/**",
    "**/.ruff_cache/**",
    "**/.tox/**",
    "**/.nox/**",
    "**/*.egg-info/**",
    "**/.eggs/**",
    "**/go/pkg/mod/**",
    "**/target/debug/**",
    "**/target/release/**",
    "**/.gradle/**",
    "**/.m2/**",
    "**/generated-sources/**",
    "**/.kotlin/**",
    "**/.dart_tool/**",
    "**/.vs/**",
    "**/.nuget/**",
    "**/artifacts/**",
    "**/publish/**",
    "**/cmake-build-*/**",
    "**/CMakeFiles/**",
    "**/bazel-*/**",
    "**/vcpkg_installed/**",
    "**/.conan/**",
    "**/Debug/**",
    "**/Release/**",
    "**/x64/**",
    "**/.pio/**",
    "**/release/**",
    "**/*.app/**",
    "**/*.asar",
    "**/DerivedData/**",
    "**/.build/**",
    "**/.swiftpm/**",
    "**/xcuserdata/**",
    "**/Carthage/Build/**",
    "**/SourcePackages/**",
    "**/__history/**",
    "**/__recovery/**",
    "**/*.dcu",
    "**/.composer/**",
    "**/storage/framework/**",
    "**/bootstrap/cache/**",
    "**/.bundle/**",
    "**/tmp/cache/**",
    "**/public/assets/**",
    "**/public/packs/**",
    "**/.yardoc/**",
    "coverage/**",
    "htmlcov/**",
    ".nyc_output/**",
    "test-results/**",
    ".coverage/**",
    "**/__snapshots__/**",
    "**/__image_snapshots__/**",
    "**/*.snap",
    "**/cassettes/**",
    "**/tests/baselines/reference/**",
    "**/tests/fixtures/baselines/**",
    "**/.idea/**",
    "**/logs/**",
    "**/tmp/**",
    "**/temp/**",
    "**/_build/**",
    "**/docs/_build/**",
    "**/site/**",
    "**/*.pb.go",
    "**/*_pb2.py",
    "**/*_pb2_grpc.py",
    "**/*.pb.cc",
    "**/*.pb.h",
    "**/*_pb.js",
    "**/*.generated.ts",
    "**/*.generated.js",
    "**/*.g.dart",
    "**/*.freezed.dart",
];

/// Validated path and nested-repository policy applied uniformly to scan, status, and indexing.
#[derive(Clone)]
pub struct DiscoveryPolicy {
    includes: Option<Arc<GlobSet>>,
    excludes: Arc<GlobSet>,
    duplicate_code_allowlist: Option<Arc<GlobSet>>,
    duplicate_code_allowlist_patterns: usize,
    enabled_languages: Option<Arc<BTreeSet<SourceLanguage>>>,
    index_submodules: bool,
    index_embedded_repositories: bool,
}

impl std::fmt::Debug for DiscoveryPolicy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DiscoveryPolicy")
            .field("has_include_allow_list", &self.includes.is_some())
            .field(
                "duplicate_code_allowlist_patterns",
                &self.duplicate_code_allowlist_patterns,
            )
            .field(
                "configured_languages",
                &self
                    .enabled_languages
                    .as_ref()
                    .map_or(0, |values| values.len()),
            )
            .field("index_submodules", &self.index_submodules)
            .field(
                "index_embedded_repositories",
                &self.index_embedded_repositories,
            )
            .finish_non_exhaustive()
    }
}

impl DiscoveryPolicy {
    /// Merge project exclusions over the immutable v1 defaults.
    pub fn new(
        project_excludes: &[String],
        index_submodules: bool,
        index_embedded_repositories: bool,
    ) -> Result<Self, DiscoveryPolicyError> {
        Self::new_with_languages(
            project_excludes,
            index_submodules,
            index_embedded_repositories,
            &[],
        )
    }

    /// Merge exclusions and an optional exact language allow-list. Empty
    /// preserves v1's automatic all-language behavior.
    pub fn new_with_languages(
        project_excludes: &[String],
        index_submodules: bool,
        index_embedded_repositories: bool,
        languages: &[SourceLanguage],
    ) -> Result<Self, DiscoveryPolicyError> {
        if project_excludes.len() > MAXIMUM_CONFIGURED_EXCLUDES {
            return Err(DiscoveryPolicyError::Limit);
        }
        let mut total = 0_usize;
        let mut builder = GlobSetBuilder::new();
        for pattern in V1_DEFAULT_EXCLUDES
            .iter()
            .copied()
            .chain(project_excludes.iter().map(String::as_str))
        {
            if pattern.is_empty()
                || pattern.len() > MAXIMUM_EXCLUDE_PATTERN_BYTES
                || pattern.contains('\0')
            {
                return Err(DiscoveryPolicyError::InvalidPattern);
            }
            total = total
                .checked_add(pattern.len())
                .ok_or(DiscoveryPolicyError::Limit)?;
            if total > MAXIMUM_EXCLUDE_TOTAL_BYTES {
                return Err(DiscoveryPolicyError::Limit);
            }
            let glob = GlobBuilder::new(pattern)
                .literal_separator(true)
                .backslash_escape(false)
                .build()
                .map_err(|_| DiscoveryPolicyError::InvalidPattern)?;
            builder.add(glob);
        }
        let excludes = builder
            .build()
            .map_err(|_| DiscoveryPolicyError::InvalidPattern)?;
        Ok(Self {
            includes: None,
            excludes: Arc::new(excludes),
            duplicate_code_allowlist: None,
            duplicate_code_allowlist_patterns: 0,
            enabled_languages: (!languages.is_empty())
                .then(|| Arc::new(languages.iter().copied().collect())),
            index_submodules,
            index_embedded_repositories: index_submodules && index_embedded_repositories,
        })
    }

    /// Exact v1 default policy.
    pub fn v1_defaults() -> Result<Self, DiscoveryPolicyError> {
        Self::new(&[], true, true)
    }

    /// Apply an exact file include-glob allow-list. `None` retains automatic
    /// native discovery; `Some([])` intentionally admits no source files.
    pub fn with_includes(
        mut self,
        patterns: Option<&[String]>,
    ) -> Result<Self, DiscoveryPolicyError> {
        let Some(patterns) = patterns else {
            self.includes = None;
            return Ok(self);
        };
        if patterns.len() > MAXIMUM_CONFIGURED_EXCLUDES {
            return Err(DiscoveryPolicyError::Limit);
        }
        let mut total = 0_usize;
        let mut builder = GlobSetBuilder::new();
        for pattern in patterns {
            if pattern.is_empty()
                || pattern.len() > MAXIMUM_EXCLUDE_PATTERN_BYTES
                || pattern.contains('\0')
            {
                return Err(DiscoveryPolicyError::InvalidPattern);
            }
            total = total
                .checked_add(pattern.len())
                .ok_or(DiscoveryPolicyError::Limit)?;
            if total > MAXIMUM_EXCLUDE_TOTAL_BYTES {
                return Err(DiscoveryPolicyError::Limit);
            }
            builder.add(
                GlobBuilder::new(pattern)
                    .literal_separator(true)
                    .backslash_escape(false)
                    .build()
                    .map_err(|_| DiscoveryPolicyError::InvalidPattern)?,
            );
        }
        self.includes = Some(Arc::new(
            builder
                .build()
                .map_err(|_| DiscoveryPolicyError::InvalidPattern)?,
        ));
        Ok(self)
    }

    /// Apply the v1 `duplicateCodeAllowlist` path globs without excluding files from indexing.
    pub fn with_duplicate_code_allowlist(
        mut self,
        patterns: &[String],
    ) -> Result<Self, DiscoveryPolicyError> {
        if patterns.len() > MAXIMUM_CONFIGURED_EXCLUDES {
            return Err(DiscoveryPolicyError::Limit);
        }
        let mut total = 0_usize;
        let mut builder = GlobSetBuilder::new();
        let mut compiled = 0_usize;
        for pattern in patterns {
            if pattern.is_empty()
                || pattern.len() > MAXIMUM_EXCLUDE_PATTERN_BYTES
                || pattern.contains('\0')
            {
                return Err(DiscoveryPolicyError::InvalidPattern);
            }
            total = total
                .checked_add(pattern.len())
                .ok_or(DiscoveryPolicyError::Limit)?;
            if total > MAXIMUM_EXCLUDE_TOTAL_BYTES {
                return Err(DiscoveryPolicyError::Limit);
            }
            if let Ok(glob) = GlobBuilder::new(pattern)
                .literal_separator(true)
                .backslash_escape(false)
                .build()
            {
                builder.add(glob);
                compiled = compiled.saturating_add(1);
            }
        }
        self.duplicate_code_allowlist = (compiled > 0)
            .then(|| {
                builder
                    .build()
                    .map(Arc::new)
                    .map_err(|_| DiscoveryPolicyError::InvalidPattern)
            })
            .transpose()?;
        self.duplicate_code_allowlist_patterns = patterns.len();
        Ok(self)
    }

    /// Whether clone biomarkers must ignore a path while retaining every other index fact.
    #[must_use]
    pub fn duplicate_code_allowlisted(&self, path: &str) -> bool {
        self.duplicate_code_allowlist
            .as_ref()
            .is_some_and(|allowlist| allowlist.is_match(path))
    }

    pub(crate) fn excludes(&self, path: &str) -> bool {
        self.excludes.is_match(path)
    }

    pub(crate) fn supports_path(&self, path: &str) -> bool {
        if self
            .includes
            .as_ref()
            .is_some_and(|includes| !includes.is_match(path))
        {
            return false;
        }
        self.enabled_languages.as_ref().map_or_else(
            || SourceLanguage::is_native_candidate_path(path),
            |languages| {
                SourceLanguage::is_native_candidate_path_where(path, |language| {
                    languages.contains(&language)
                })
            },
        )
    }

    pub(crate) fn allows_language(&self, language: SourceLanguage) -> bool {
        self.enabled_languages
            .as_ref()
            .is_none_or(|languages| languages.contains(&language))
    }

    pub(crate) const fn index_submodules(&self) -> bool {
        self.index_submodules
    }

    pub(crate) const fn index_embedded_repositories(&self) -> bool {
        self.index_embedded_repositories
    }
}

/// A project discovery policy was malformed or exceeded a defensive bound.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum DiscoveryPolicyError {
    #[error("Cartograph project exclusion glob is invalid")]
    InvalidPattern,
    #[error("Cartograph project exclusion policy exceeds its bound")]
    Limit,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_preserve_source_bin_but_reject_root_bin_and_build_trees() {
        let policy = DiscoveryPolicy::v1_defaults()
            .unwrap_or_else(|error| panic!("default policy failed: {error}"));
        assert!(policy.excludes("bin/tool.ts"));
        assert!(!policy.excludes("src/bin/tool.ts"));
        assert!(policy.excludes("packages/app/dist/index.js"));
        assert!(policy.excludes("target/debug/generated.rs"));
    }

    #[test]
    fn project_excludes_extend_defaults_and_nested_repositories_are_fail_closed() {
        let policy = DiscoveryPolicy::new(&["private/**".to_owned()], false, true)
            .unwrap_or_else(|error| panic!("project policy failed: {error}"));
        assert!(policy.excludes("private/key.ts"));
        assert!(policy.excludes("node_modules/pkg/index.js"));
        assert!(!policy.index_submodules());
        assert!(!policy.index_embedded_repositories());
    }

    #[test]
    fn language_allow_list_filters_exact_paths_and_keeps_ambiguous_candidates() {
        let policy = DiscoveryPolicy::new_with_languages(
            &[],
            true,
            true,
            &[SourceLanguage::Cpp, SourceLanguage::Rust],
        )
        .unwrap_or_else(|error| panic!("language policy failed: {error}"));
        assert!(policy.supports_path("src/lib.rs"));
        assert!(!policy.supports_path("src/app.ts"));
        assert!(policy.supports_path("include/service.h"));
        assert!(policy.allows_language(SourceLanguage::Cpp));
        assert!(!policy.allows_language(SourceLanguage::C));
    }

    #[test]
    fn include_allow_list_is_distinct_from_exclusions_and_can_be_empty() {
        let patterns = vec!["src/**/*.rs".to_owned()];
        let policy = DiscoveryPolicy::v1_defaults()
            .and_then(|policy| policy.with_includes(Some(&patterns)))
            .unwrap_or_else(|error| panic!("include policy failed: {error}"));
        assert!(policy.supports_path("src/lib.rs"));
        assert!(!policy.supports_path("tests/lib.rs"));
        let empty = DiscoveryPolicy::v1_defaults()
            .and_then(|policy| policy.with_includes(Some(&[])))
            .unwrap_or_else(|error| panic!("empty include policy failed: {error}"));
        assert!(!empty.supports_path("src/lib.rs"));
    }

    #[test]
    fn duplicate_allowlist_suppresses_only_clone_analysis_and_skips_invalid_globs() {
        let patterns = vec!["generated/**".to_owned(), "[invalid".to_owned()];
        let policy = DiscoveryPolicy::v1_defaults()
            .and_then(|policy| policy.with_duplicate_code_allowlist(&patterns))
            .unwrap_or_else(|error| panic!("clone allowlist failed: {error}"));
        assert!(policy.supports_path("generated/copied.rs"));
        assert!(policy.duplicate_code_allowlisted("generated/copied.rs"));
        assert!(!policy.duplicate_code_allowlisted("src/copied.rs"));
    }
}
