import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const checkWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/check.yml'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');

describe('release workflow integrity', () => {
  it('reuses the required CI workflow for the exact release ref', () => {
    expect(checkWorkflow).toContain('workflow_call:');
    expect(releaseWorkflow).toMatch(/gate:\n\s+uses: \.\/\.github\/workflows\/check\.yml/);
  });

  it('publishes only tag builds and never exposes a published-release overwrite input', () => {
    expect(releaseWorkflow).not.toContain('overwrite:');
    expect(releaseWorkflow).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    expect(releaseWorkflow).toContain('--draft');
    expect(releaseWorkflow).toContain('--draft=false');
    expect(releaseWorkflow).toContain('isDraft');
  });

  it('keeps write permissions on publish only and attests the checksummed artifacts', () => {
    expect(releaseWorkflow).toMatch(/permissions:\n\s+contents: read/);
    expect(releaseWorkflow).toMatch(/publish:[\s\S]*?permissions:\n\s+contents: write/);
    expect(releaseWorkflow).toContain('attestations: write');
    expect(releaseWorkflow).toContain('id-token: write');
    expect(releaseWorkflow).toContain('subject-checksums: release/SHA256SUMS');
  });

  it('pins every external action to a full commit SHA', () => {
    const externalActions = [...`${checkWorkflow}\n${releaseWorkflow}`.matchAll(/uses:\s+(?!\.\/)([^@\s]+)@([^\s]+)/g)];
    expect(externalActions.length).toBeGreaterThan(0);
    for (const action of externalActions) {
      expect(action[2], `${action[1]} must use a full commit SHA`).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
