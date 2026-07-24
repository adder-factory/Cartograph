use std::{fmt, str::FromStr};

use serde::Serialize;

/// Advertised MCP tool surface selected for one connection.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolProfile {
    /// Small default coding-agent surface.
    #[default]
    Core,
    /// Read-only discovery and inspection surface.
    ReadOnly,
    /// Review and verification surface.
    Review,
}

impl ToolProfile {
    /// Stable CLI/config spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::ReadOnly => "read-only",
            Self::Review => "review",
        }
    }
}

impl fmt::Display for ToolProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ToolProfile {
    type Err = ToolContractError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "core" => Ok(Self::Core),
            "read-only" => Ok(Self::ReadOnly),
            "review" => Ok(Self::Review),
            _ => Err(ToolContractError::InvalidProfile),
        }
    }
}

/// Exact profile-membership bits attached to a tool definition.
///
/// Profiles are intentionally not hierarchical: the adapter declares each
/// tool's exact membership to preserve the existing Cartograph allowlists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolProfiles(u8);

impl ToolProfiles {
    /// Empty membership used when building a set incrementally.
    pub const NONE: Self = Self(0);
    /// Included in the core profile.
    pub const CORE: Self = Self(0b001);
    /// Included in the read-only profile.
    pub const READ_ONLY: Self = Self(0b010);
    /// Included in the review profile.
    pub const REVIEW: Self = Self(0b100);
    /// Included in every supported profile.
    pub const ALL: Self = Self(Self::CORE.0 | Self::READ_ONLY.0 | Self::REVIEW.0);

    /// Combine profile membership without allocation.
    #[must_use]
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// Return whether this membership set advertises a tool in `profile`.
    #[must_use]
    pub const fn includes(self, profile: ToolProfile) -> bool {
        let bit = match profile {
            ToolProfile::Core => Self::CORE.0,
            ToolProfile::ReadOnly => Self::READ_ONLY.0,
            ToolProfile::Review => Self::REVIEW.0,
        };
        self.0 & bit != 0
    }

    pub(crate) const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

use crate::ToolContractError;
