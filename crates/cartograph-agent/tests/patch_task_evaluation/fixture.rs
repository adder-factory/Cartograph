use std::{fmt::Write as _, fs, path::Path};

pub(crate) const V1_CASE_FINGERPRINT: &str =
    "48af5dde705ed932c5cc255ca53e8250287fc497ba874a7df5f7cacf8010eeec";
pub(crate) const FIXTURE_SOURCE_FINGERPRINT: &str =
    "b35332df4f340cd467fb3e1917a89e7d327b92638daca9d1188ae0de571d745c";

const FIXTURE_FINGERPRINT_DOMAIN: &[u8] = b"cartograph-v2-patch-task-fixture-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FixtureFile {
    pub(crate) path: &'static str,
    pub(crate) source: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PatchCase {
    pub(crate) id: &'static str,
    pub(crate) task: &'static str,
    pub(crate) expected_symbols: &'static [&'static str],
    pub(crate) expected_edit_files: &'static [&'static str],
    pub(crate) expected_test_files: &'static [&'static str],
    pub(crate) should_abstain: bool,
}

pub(crate) const FILES: [FixtureFile; 9] = [
    FixtureFile {
        path: "src/sync.ts",
        source: r#"export interface SyncResult { changed: number; }

/** Re-index the files supplied by the watcher. */
export function runSync(files: string[]): SyncResult {
  return { changed: files.length };
}
"#,
    },
    FixtureFile {
        path: "src/watcher.ts",
        source: r#"import { runSync } from './sync.js';

export interface WatcherOptions { debounceMs: number; }
export interface WatcherState { pending: string[]; running: boolean; }

/** Gate filesystem events before an incremental sync is triggered. */
export function watcherHandleFileEvent(state: WatcherState, filePath: string): void {
  if (filePath.length === 0) return;
  state.pending.push(filePath);
  runSync(state.pending);
}

export class FileWatcher {
  private state: WatcherState = { pending: [], running: false };
  constructor(private readonly options: WatcherOptions) {}
  onEvent(filePath: string): void { watcherHandleFileEvent(this.state, filePath); }
}
"#,
    },
    FixtureFile {
        path: "src/auth.ts",
        source: r#"export interface AuthSession { userId: string; token: string; }

/** Reject malformed authentication tokens before session creation. */
export function validateToken(token: string): boolean {
  return token.startsWith('token:');
}

export function authenticateUser(userId: string, token: string): AuthSession | null {
  if (!validateToken(token)) return null;
  return { userId, token };
}
"#,
    },
    FixtureFile {
        path: "src/payment.ts",
        source: r#"export interface PaymentResult { ok: boolean; amount: number; }

export function processPayment(amount: number): PaymentResult {
  return { ok: amount > 0, amount };
}

/** Reverse a charge without accepting a negative refund input. */
export function refundPayment(amount: number): PaymentResult {
  return processPayment(Math.abs(amount));
}
"#,
    },
    FixtureFile {
        path: "src/postgres-maintenance.ts",
        source: r#"export const POSTGRES_ANALYZE_CURRENT_SCHEMA_SQL = 'ANALYZE';
export interface SyncWriteResult { filesModified: number; hookWrites: number; }
export interface MaintenanceDb { exec(sql: string): void; }

/** Decide whether incremental indexing wrote enough to refresh planner statistics. */
export function cgSyncHasDatabaseWrites(result: SyncWriteResult): boolean {
  return result.filesModified > 0 || result.hookWrites > 0;
}

export function dbRunMaintenance(db: MaintenanceDb): void {
  db.exec(POSTGRES_ANALYZE_CURRENT_SCHEMA_SQL);
}

/** Skip PostgreSQL ANALYZE when sync made no database writes. */
export function syncPostgresGraph(result: SyncWriteResult, db: MaintenanceDb): void {
  if (cgSyncHasDatabaseWrites(result)) dbRunMaintenance(db);
}
"#,
    },
    FixtureFile {
        path: "tests/watcher.test.ts",
        source: r#"import { describe, expect, it } from 'vitest';
import { watcherHandleFileEvent, type WatcherState } from '../src/watcher.js';

describe('watcher event gate', () => {
  it('ignores an empty path', () => {
    const state: WatcherState = { pending: [], running: true };
    watcherHandleFileEvent(state, '');
    expect(state.pending).toEqual([]);
  });
});
"#,
    },
    FixtureFile {
        path: "tests/auth.test.ts",
        source: r#"import { describe, expect, it } from 'vitest';
import { authenticateUser, validateToken } from '../src/auth.js';

describe('authentication tokens', () => {
  it('rejects malformed tokens', () => {
    expect(validateToken('bad')).toBe(false);
    expect(authenticateUser('u1', 'bad')).toBeNull();
  });
});
"#,
    },
    FixtureFile {
        path: "tests/payment.test.ts",
        source: r#"import { describe, expect, it } from 'vitest';
import { refundPayment } from '../src/payment.js';

describe('refunds', () => {
  it('normalizes the amount', () => {
    expect(refundPayment(-2).amount).toBe(2);
  });
});
"#,
    },
    FixtureFile {
        path: "tests/postgres-maintenance.test.ts",
        source: r#"import { describe, expect, it, vi } from 'vitest';
import { syncPostgresGraph } from '../src/postgres-maintenance.js';

describe('PostgreSQL maintenance', () => {
  it('skips planner refresh after a no-op sync', () => {
    const exec = vi.fn();
    syncPostgresGraph({ filesModified: 0, hookWrites: 0 }, { exec });
    expect(exec).not.toHaveBeenCalled();
  });
});
"#,
    },
];

pub(crate) const CASES: [PatchCase; 5] = [
    PatchCase {
        id: "watcher-empty-path",
        task: "Fix the watcher event gate so an empty file path never triggers incremental sync",
        expected_symbols: &["watcherHandleFileEvent"],
        expected_edit_files: &["src/watcher.ts"],
        expected_test_files: &["tests/watcher.test.ts"],
        should_abstain: false,
    },
    PatchCase {
        id: "auth-malformed-token",
        task: "Reject a malformed authentication token before creating an AuthSession",
        expected_symbols: &["validateToken", "authenticateUser"],
        expected_edit_files: &["src/auth.ts"],
        expected_test_files: &["tests/auth.test.ts"],
        should_abstain: false,
    },
    PatchCase {
        id: "refund-negative-input",
        task: "Fix refund processing so a negative refund input is normalized before charging",
        expected_symbols: &["refundPayment", "processPayment"],
        expected_edit_files: &["src/payment.ts"],
        expected_test_files: &["tests/payment.test.ts"],
        should_abstain: false,
    },
    PatchCase {
        id: "postgres-noop-maintenance",
        task: "When incremental indexing makes no writes, avoid refreshing PostgreSQL planner statistics",
        expected_symbols: &["syncPostgresGraph", "cgSyncHasDatabaseWrites"],
        expected_edit_files: &["src/postgres-maintenance.ts"],
        expected_test_files: &["tests/postgres-maintenance.test.ts"],
        should_abstain: false,
    },
    PatchCase {
        id: "absent-mobile-push",
        task: "Change the mobile push-notification retry backoff and APNS delivery policy",
        expected_symbols: &[],
        expected_edit_files: &[],
        expected_test_files: &[],
        should_abstain: true,
    },
];

pub(crate) fn materialize(root: &Path) -> Result<(), String> {
    for file in FILES {
        let destination = root.join(file.path);
        let parent = destination
            .parent()
            .ok_or_else(|| "fixture path has no parent".to_owned())?;
        fs::create_dir_all(parent).map_err(|_| "fixture directory creation failed".to_owned())?;
        fs::write(destination, file.source).map_err(|_| "fixture write failed".to_owned())?;
    }
    Ok(())
}

pub(crate) fn case_fingerprint() -> String {
    let mut cases = CASES.to_vec();
    cases.sort_by_key(|case| case.id);
    let mut canonical = String::from("[");
    for (index, case) in cases.iter().enumerate() {
        if index > 0 {
            canonical.push(',');
        }
        canonical.push('{');
        json_field(&mut canonical, "id", case.id);
        canonical.push(',');
        json_field(&mut canonical, "task", case.task);
        canonical.push(',');
        json_array_field(&mut canonical, "expectedSymbols", case.expected_symbols);
        canonical.push(',');
        json_array_field(
            &mut canonical,
            "expectedEditFiles",
            case.expected_edit_files,
        );
        canonical.push(',');
        json_array_field(
            &mut canonical,
            "expectedTestFiles",
            case.expected_test_files,
        );
        canonical.push_str(",\"shouldAbstain\":");
        canonical.push_str(if case.should_abstain { "true" } else { "false" });
        canonical.push('}');
    }
    canonical.push(']');
    sha256_hex(canonical.as_bytes())
}

pub(crate) fn fixture_source_fingerprint() -> String {
    let mut hasher = blake3::Hasher::new();
    hash_field(&mut hasher, FIXTURE_FINGERPRINT_DOMAIN);
    hash_field(
        &mut hasher,
        &u64::try_from(FILES.len()).unwrap_or(u64::MAX).to_le_bytes(),
    );
    for file in FILES {
        hash_field(&mut hasher, file.path.as_bytes());
        hash_field(&mut hasher, file.source.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn hash_field(hasher: &mut blake3::Hasher, value: &[u8]) {
    hasher.update(&u64::try_from(value.len()).unwrap_or(u64::MAX).to_le_bytes());
    hasher.update(value);
}

fn json_field(output: &mut String, name: &str, value: &str) {
    json_string(output, name);
    output.push(':');
    json_string(output, value);
}

fn json_array_field(output: &mut String, name: &str, values: &[&str]) {
    json_string(output, name);
    output.push_str(":[");
    let mut values = values.to_vec();
    values.sort_unstable();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        json_string(output, value);
    }
    output.push(']');
}

fn json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if control <= '\u{001f}' => {
                let _ = write!(output, "\\u{:04x}", u32::from(control));
            }
            other => output.push(other),
        }
    }
    output.push('"');
}

pub(crate) fn sha256_hex(input: &[u8]) -> String {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const ROUND: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_length = u64::try_from(input.len())
        .unwrap_or(u64::MAX)
        .wrapping_mul(8);
    let mut padded = input.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_length.to_be_bytes());

    let mut state = INITIAL;
    for chunk in padded.chunks_exact(64) {
        let mut words = [0_u32; 64];
        for (index, bytes) in chunk.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let upper_e = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let first = h
                .wrapping_add(upper_e)
                .wrapping_add(choice)
                .wrapping_add(ROUND[index])
                .wrapping_add(words[index]);
            let upper_a = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let second = upper_a.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(first);
            d = c;
            c = b;
            b = a;
            a = first.wrapping_add(second);
        }
        for (value, addition) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *value = value.wrapping_add(addition);
        }
    }

    let mut output = String::with_capacity(64);
    for value in state {
        let _ = write!(output, "{value:08x}");
    }
    output
}
