import { describe, expect, it } from 'vitest';
import { checkUpgrade, compareVersions, renderUpgradeCheck } from '../src/features/upgrade/index.js';

describe('upgrade feature', () => {
  it('compares semver-like versions', () => {
    expect(compareVersions('0.7.2', '0.7.3')).toBeLessThan(0);
    expect(compareVersions('0.8.0', '0.7.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('reports update availability without applying mutations', async () => {
    const result = await checkUpgrade({
      currentVersion: '0.7.2',
      latestVersion: '0.8.0',
      apply: true,
    });

    expect(result.status).toBe('update_available');
    expect(result.applied).toBe(false);
    expect(result.nextSteps.join('\n')).toContain('git pull');
    expect(renderUpgradeCheck(result)).toContain('Cartograph 0.8.0 is available');
  });

  it('surfaces registry lookup failures as unknown status', async () => {
    const result = await checkUpgrade({
      currentVersion: '0.7.2',
      fetchLatestVersion: async () => {
        throw new Error('offline');
      },
    });

    expect(result.status).toBe('unknown');
    expect(result.warning).toContain('offline');
  });
});
