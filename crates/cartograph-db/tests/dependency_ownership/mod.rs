//! Explicit package-dependency ownership for independently compiled integration targets.
//!
//! Each live test uses a narrow public API slice, while Cargo exposes the package-wide dependency
//! set to every test crate. These underscore imports make that target-granularity ownership explicit.

use blake3 as _;
use cartograph_config as _;
use cartograph_domain as _;
use cartograph_test_support as _;
use futures_util as _;
use getrandom as _;
use libc as _;
use num_traits as _;
use secrecy as _;
use serde as _;
use serde_json as _;
use sha2 as _;
use sqlx_core as _;
use sqlx_postgres as _;
use tempfile as _;
use thiserror as _;
use tokio as _;
use unicode_ident as _;
use url as _;
