import { describe, expect, it } from 'vitest';
import { codeIgniterResolver } from '../src/resolution/frameworks/codeigniter.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import type { Language, Node, NodeKind } from '../src/types.js';

function node(args: { id: string; name: string; kind: NodeKind; filePath: string }): Node {
  const { id, name, kind, filePath } = args;
  return {
    id,
    name,
    kind,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'php',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: name.length,
    updatedAt: 1,
  };
}

function ref(referenceName: string): UnresolvedRef {
  return {
    fromNodeId: 'source',
    referenceName,
    referenceKind:
      referenceName.startsWith('ci3:member:') || referenceName.startsWith('ci3:route:') ? 'calls' : 'references',
    line: 1,
    column: 0,
    filePath: 'application/config/routes.php',
    language: 'php',
  };
}

function context(files: Record<string, string>, nodes: Node[] = []): ResolutionContext {
  return {
    getNodesInFile: (filePath: string) => nodes.filter((item) => item.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter((item) => item.name === name),
    getNodesByQualifiedName: (qualifiedName: string) => nodes.filter((item) => item.qualifiedName === qualifiedName),
    getNodesByKind: (kind: NodeKind) => nodes.filter((item) => item.kind === kind),
    fileExists: (filePath: string) => Object.hasOwn(files, filePath),
    readFile: (filePath: string) => files[filePath] ?? null,
    getProjectRoot: () => '/tmp/codeigniter-project',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: (lowerName: string) => nodes.filter((item) => item.name.toLowerCase() === lowerName),
    getImportMappings: (_filePath: string, _language: Language) => [],
  };
}

describe('CodeIgniter 3 framework resolver', () => {
  it('detects CI3 projects from routes/config and application paths', () => {
    expect(
      codeIgniterResolver.detect(
        context({
          'application/config/routes.php': '',
          'application/controllers/Welcome.php': '',
          'index.php': '',
        }),
      ),
    ).toBe(true);

    expect(codeIgniterResolver.detect(context({ 'src/routes.php': '' }))).toBe(false);
  });

  it('extracts CI3 route-array entries with handler references', () => {
    const output = codeIgniterResolver.extract!(
      'application/config/routes.php',
      [
        '<?php',
        "$route['default_controller'] = 'welcome';",
        "$route['product/(:num)']['DELETE'] = 'catalog/product_lookup_by_id/$1';",
        "$route['translate_uri_dashes'] = FALSE;",
      ].join('\n'),
    );

    expect(output.nodes.map((item) => item.name)).toEqual(['ANY /', 'DELETE /product/(:num)']);
    expect(output.references.map((item) => item.referenceName)).toEqual([
      'ci3:route:welcome',
      'ci3:route:catalog/product_lookup_by_id/$1',
    ]);
  });

  it('extracts convention routes from public controller methods only', () => {
    const output = codeIgniterResolver.extract!(
      'application/controllers/admin/Users.php',
      [
        '<?php',
        'class Users extends CI_Controller {',
        '  public function index() {}',
        '  public function show($id) {}',
        '  public function _remap($method) {}',
        '  protected function hidden() {}',
        '}',
      ].join('\n'),
    );

    expect(output.nodes.map((item) => item.name)).toEqual(['ANY /admin/users', 'ANY /admin/users/show']);
    expect(output.references.map((item) => item.referenceName)).toEqual([
      'ci3:route:admin/users/index',
      'ci3:route:admin/users/show',
    ]);
  });

  it('extracts model and library load refs plus same-file magic property calls', () => {
    const output = codeIgniterResolver.extract!(
      'application/controllers/Users.php',
      [
        '<?php',
        'class Users extends CI_Controller {',
        '  public function show() {',
        "    $this->load->model('user_model');",
        "    $this->load->model('blog/queries', 'queryModel');",
        "    $this->load->library('email');",
        '    $this->user_model->active();',
        '    $this->queryModel->find();',
        '    $this->email->send();',
        '    $this->db->get();',
        '  }',
        '}',
      ].join('\n'),
    );

    expect(output.references.map((item) => item.referenceName)).toEqual([
      'ci3:route:users/show',
      'ci3:symbol:model:user_model',
      'ci3:symbol:model:blog/queries',
      'ci3:symbol:library:email',
      'ci3:member:model:user_model.active',
      'ci3:member:model:blog/queries.find',
      'ci3:member:library:email.send',
    ]);
  });

  it('resolves CI3 route, model, and library refs by convention', () => {
    const nodes = [
      node({ id: 'welcome-index', name: 'index', kind: 'method', filePath: 'application/controllers/Welcome.php' }),
      node({
        id: 'catalog-lookup',
        name: 'product_lookup_by_id',
        kind: 'method',
        filePath: 'application/controllers/Catalog.php',
      }),
      node({ id: 'users-show', name: 'show', kind: 'method', filePath: 'application/controllers/admin/Users.php' }),
      node({ id: 'user-model', name: 'User_model', kind: 'class', filePath: 'application/models/User_model.php' }),
      node({ id: 'user-active', name: 'active', kind: 'method', filePath: 'application/models/User_model.php' }),
      node({ id: 'queries-model', name: 'Queries', kind: 'class', filePath: 'application/models/blog/Queries.php' }),
      node({ id: 'query-find', name: 'find', kind: 'method', filePath: 'application/models/blog/Queries.php' }),
      node({ id: 'email-library', name: 'Email', kind: 'class', filePath: 'application/libraries/Email.php' }),
      node({ id: 'email-send', name: 'send', kind: 'method', filePath: 'application/libraries/Email.php' }),
    ];
    const ctx = context(
      {
        'application/controllers/Welcome.php': '',
        'application/controllers/Catalog.php': '',
        'application/controllers/admin/Users.php': '',
        'application/models/User_model.php': '',
        'application/models/blog/Queries.php': '',
        'application/libraries/Email.php': '',
      },
      nodes,
    );

    expect(codeIgniterResolver.resolve(ref('ci3:route:welcome'), ctx)).toMatchObject({
      targetNodeId: 'welcome-index',
      confidence: 0.9,
    });
    expect(codeIgniterResolver.resolve(ref('ci3:route:catalog/product_lookup_by_id/$1'), ctx)).toMatchObject({
      targetNodeId: 'catalog-lookup',
    });
    expect(codeIgniterResolver.resolve(ref('ci3:route:admin/users/show'), ctx)).toMatchObject({
      targetNodeId: 'users-show',
    });
    expect(codeIgniterResolver.resolve(ref('ci3:symbol:model:blog/queries'), ctx)).toMatchObject({
      targetNodeId: 'queries-model',
    });
    expect(codeIgniterResolver.resolve(ref('ci3:member:model:user_model.active'), ctx)).toMatchObject({
      targetNodeId: 'user-active',
    });
    expect(codeIgniterResolver.resolve(ref('ci3:member:library:email.send'), ctx)).toMatchObject({
      targetNodeId: 'email-send',
    });
  });
});
