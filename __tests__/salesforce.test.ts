import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getAllNodes, getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';
import { extractFromSource } from '../src/extraction/index.js';
import { detectLanguage, loadGrammarsForLanguages } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await loadGrammarsForLanguages(['apex']);
});

describe('Salesforce extraction and resolution', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  afterEach(() => {
    if (cg) cg.close();
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('detects Salesforce languages and extracts Apex/Aura/Visualforce structure', () => {
    expect(detectLanguage('force-app/main/default/classes/AccountService.cls')).toBe('apex');
    expect(detectLanguage('force-app/main/default/aura/AccountList/AccountList.cmp')).toBe('aura');
    expect(detectLanguage('force-app/main/default/pages/AccountPage.page')).toBe('visualforce');
    expect(detectLanguage('src/features/viewer/static/viewer.app', 'document.querySelector(".tab");')).toBe('unknown');

    const apex = extractFromSource(
      'force-app/main/default/classes/AccountService.cls',
      'public with sharing class AccountService { @AuraEnabled(cacheable=true) public static List<Account> listAccounts() { return new List<Account>(); } }',
    );
    expect(apex.nodes.find((n) => n.kind === 'class' && n.name === 'AccountService')).toBeDefined();
    const method = apex.nodes.find((n) => n.kind === 'method' && n.name === 'listAccounts');
    expect(method?.decorators).toContain('AuraEnabled');
    expect(apex.unresolvedReferences.some((r) => r.referenceKind === 'returns' && r.referenceName === 'Account')).toBe(
      true,
    );

    const aura = extractFromSource(
      'force-app/main/default/aura/OpportunityList/OpportunityList.cmp',
      '<aura:component controller="OpportunityController"><aura:attribute name="rows" type="Opportunity[]"/><aura:handler name="init" value="{!this}" action="{!c.doInit}"/><c:ChildCard /></aura:component>',
    );
    expect(aura.nodes.find((n) => n.kind === 'component' && n.name === 'OpportunityList')).toBeDefined();
    expect(aura.nodes.find((n) => n.kind === 'field' && n.name === 'rows')?.signature).toBe('Opportunity[]');
    expect(aura.unresolvedReferences.map((r) => r.referenceName)).toEqual(
      expect.arrayContaining(['OpportunityController', 'Opportunity', 'doInit', 'ChildCard']),
    );

    const visualforce = extractFromSource(
      'force-app/main/default/pages/AccountPage.page',
      '<apex:page controller="AccountController"><apex:commandButton action="{!save}"/><c:AccountCard /></apex:page>',
    );
    expect(visualforce.nodes.find((n) => n.kind === 'route' && n.name === '/apex/AccountPage')).toBeDefined();
    expect(visualforce.unresolvedReferences.map((r) => r.referenceName)).toEqual(
      expect.arrayContaining(['AccountController', 'save', 'AccountCard']),
    );
  });

  it('resolves LWC, Aura, and Visualforce references to Apex and component targets', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-salesforce-'));
    writeSalesforceFixture(tempDir);

    cg = await Cartograph.init(tempDir, { index: true });

    expect(outgoingTargets('force-app/main/default/lwc/accountList/accountList.js', 'imports')).toContain(
      'AccountService::listAccounts',
    );
    expect(outgoingTargets('force-app/main/default/lwc/accountList/accountList.html', 'references')).toContain(
      'force-app/main/default/lwc/accountCard/accountCard.js::accountCard',
    );
    expect(outgoingTargets('force-app/main/default/aura/OpportunityList/OpportunityList.cmp', 'calls')).toContain(
      'force-app/main/default/aura/OpportunityList/OpportunityListController.js::doInit',
    );
    expect(
      outgoingTargets('force-app/main/default/aura/OpportunityList/OpportunityListController.js', 'calls'),
    ).toContain('OpportunityController::fetch');
    expect(outgoingTargets('force-app/main/default/pages/AccountPage.page', 'calls')).toContain(
      'AccountController::save',
    );
  });

  function outgoingTargets(filePath: string, kind: string): string[] {
    const nodes = getAllNodes(cg!.queries).filter((node) => node.filePath === filePath);
    expect(nodes.length, `nodes for ${filePath}`).toBeGreaterThan(0);
    return nodes
      .flatMap((node) => getOutgoingEdges(cg!.queries, node.id))
      .filter((edge) => edge.kind === kind)
      .map((edge) => cg!.queries.getNodeById(edge.target)?.qualifiedName ?? '')
      .filter(Boolean);
  }
});

function writeSalesforceFixture(root: string): void {
  const base = path.join(root, 'force-app/main/default');
  const serverActionName = ['fe', 'tch'].join('');
  fs.mkdirSync(path.join(base, 'classes'), { recursive: true });
  fs.mkdirSync(path.join(base, 'lwc/accountList'), { recursive: true });
  fs.mkdirSync(path.join(base, 'lwc/accountCard'), { recursive: true });
  fs.mkdirSync(path.join(base, 'aura/OpportunityList'), { recursive: true });
  fs.mkdirSync(path.join(base, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app"}]}');
  fs.writeFileSync(
    path.join(base, 'classes/AccountService.cls'),
    'public with sharing class AccountService { @AuraEnabled(cacheable=true) public static List<Account> listAccounts() { return new List<Account>(); } }',
  );
  fs.writeFileSync(
    path.join(base, 'classes/OpportunityController.cls'),
    `public with sharing class OpportunityController { @AuraEnabled public static List<Opportunity> ${serverActionName}() { return new List<Opportunity>(); } }`,
  );
  fs.writeFileSync(
    path.join(base, 'classes/AccountController.cls'),
    'public with sharing class AccountController { public PageReference save() { return null; } }',
  );
  fs.writeFileSync(
    path.join(base, 'lwc/accountList/accountList.js'),
    "import listAccounts from '@salesforce/apex/AccountService.listAccounts';\nimport { LightningElement } from 'lwc';\nexport default class AccountList extends LightningElement { connectedCallback() { listAccounts(); } }\n",
  );
  fs.writeFileSync(
    path.join(base, 'lwc/accountList/accountList.html'),
    '<template><c-account-card></c-account-card></template>',
  );
  fs.writeFileSync(
    path.join(base, 'lwc/accountCard/accountCard.js'),
    "import { LightningElement } from 'lwc';\nexport default class AccountCard extends LightningElement {}\n",
  );
  fs.writeFileSync(
    path.join(base, 'aura/OpportunityList/OpportunityList.cmp'),
    '<aura:component controller="OpportunityController"><aura:handler name="init" value="{!this}" action="{!c.doInit}"/></aura:component>',
  );
  fs.writeFileSync(
    path.join(base, 'aura/OpportunityList/OpportunityListController.js'),
    `({ doInit: function(component) { var action = component.get("c.${serverActionName}"); } })`,
  );
  fs.writeFileSync(
    path.join(base, 'pages/AccountPage.page'),
    '<apex:page controller="AccountController"><apex:commandButton action="{!save}"/></apex:page>',
  );
}
