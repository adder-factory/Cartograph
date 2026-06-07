import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';

describe('Ruby receiver method-call resolution', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-ruby-receiver-'));
  });

  afterEach(() => {
    cg?.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves local variables assigned from Class.new and chained Class.new.method calls', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'app.rb'),
      [
        'class Repository',
        '  def save',
        '  end',
        'end',
        '',
        'class Other',
        '  def save',
        '  end',
        'end',
        '',
        'def run_local',
        '  repo = Repository.new',
        '  repo.save',
        'end',
        '',
        'def run_chained',
        '  Repository.new.save',
        'end',
        '',
      ].join('\n'),
    );

    cg = Cartograph.initSync(tempDir, { config: { enableWatcher: false, include: ['**/*.rb'] } });
    const result = await cg.indexAll({ summarize: false });
    expect(result.success).toBe(true);

    const methods = getNodesByKind(cg.queries, 'method');
    const repositorySave = methods.find((n) => n.name === 'save' && n.qualifiedName === 'Repository::save');
    const otherSave = methods.find((n) => n.name === 'save' && n.qualifiedName === 'Other::save');
    expect(repositorySave).toBeDefined();
    expect(otherSave).toBeDefined();

    const repositoryCallers = cg.internals.traverser.getCallers(repositorySave!.id).map((c) => c.node.name);
    expect(repositoryCallers).toEqual(expect.arrayContaining(['run_local', 'run_chained']));

    const otherCallers = cg.internals.traverser.getCallers(otherSave!.id).map((c) => c.node.name);
    expect(otherCallers).not.toContain('run_local');
    expect(otherCallers).not.toContain('run_chained');
  });
});
