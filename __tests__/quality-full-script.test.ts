import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const script = fs.readFileSync(path.resolve(import.meta.dir, '..', 'scripts', 'quality-full.sh'), 'utf8');

describe('quality-full Sonar integration', () => {
  it('uses the configured modern Sonar helper and still waits for the analysis-specific quality gate', () => {
    expect(script).toContain('require_command sonar');
    expect(script).toContain('sonar scan');
    expect(script).not.toContain('sonar-scanner');
    expect(script).toContain('qualitygates/project_status?analysisId=$analysis_id');
  });
});
