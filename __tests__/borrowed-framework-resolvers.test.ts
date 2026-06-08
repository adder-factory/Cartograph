import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import { angularResolver } from '../src/resolution/frameworks/angular.js';
import { flutterResolver } from '../src/resolution/frameworks/flutter.js';
import { neugResolver } from '../src/resolution/frameworks/neug.js';
import { symfonyResolver } from '../src/resolution/frameworks/symfony.js';

function node(partial: Partial<Node> & Pick<Node, 'id' | 'name' | 'kind' | 'filePath'>): Node {
  return {
    qualifiedName: partial.name,
    language: 'php',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
    ...partial,
  };
}

function context(files: Record<string, string>, nodes: Node[] = []): ResolutionContext {
  return {
    getNodesInFile: (filePath) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qualifiedName) => nodes.filter((n) => n.qualifiedName === qualifiedName),
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    fileExists: (filePath) => Object.hasOwn(files, filePath),
    readFile: (filePath) => files[filePath] ?? null,
    getProjectRoot: () => '/project',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: (lowerName) => nodes.filter((n) => n.name.toLowerCase() === lowerName),
    getImportMappings: () => [],
  };
}

function ref(referenceName: string): UnresolvedRef {
  return {
    fromNodeId: 'route',
    referenceName,
    referenceKind: 'calls',
    line: 1,
    column: 0,
    filePath: 'config/routes.yaml',
    language: 'yaml',
  };
}

describe('borrowed framework resolver additions', () => {
  it('detects Angular and extracts static route component/lazy-import references', () => {
    const ctx = context({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0', '@angular/router': '^20.0.0' } }),
    });
    expect(angularResolver.detect(ctx)).toBe(true);

    const result = angularResolver.extract!(
      'src/app/app.routes.ts',
      `
import { Routes } from '@angular/router';
export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'admin', loadChildren: () => import('./admin/admin.routes') },
  { path: 'settings', loadComponent: () => import('./settings.component').then(m => m.SettingsComponent) },
];
`,
    );

    expect(result.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['/', '/admin', '/settings']));
    expect(result.references.map((r) => `${r.referenceKind}:${r.referenceName}`)).toEqual(
      expect.arrayContaining([
        'references:HomeComponent',
        'imports:./admin/admin.routes',
        'imports:./settings.component',
        'references:SettingsComponent',
      ]),
    );
  });

  it('detects Flutter and extracts MaterialApp and GoRoute routes', () => {
    const ctx = context({
      'pubspec.yaml': 'name: demo\nflutter:\n  uses-material-design: true\n',
    });
    expect(flutterResolver.detect(ctx)).toBe(true);

    const nodesAndRefs = flutterResolver.extract!(
      'lib/main.dart',
      `
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

final router = GoRouter(routes: [
  GoRoute(path: '/profile', builder: (context, state) => ProfilePage()),
]);

MaterialApp(routes: {
  '/': (context) => HomePage(),
  '/settings': (_) => const SettingsPage(),
});
`,
    );

    expect(nodesAndRefs.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['/', '/settings', '/profile']));
    expect(nodesAndRefs.references.map((r) => r.referenceName)).toEqual(
      expect.arrayContaining(['HomePage', 'SettingsPage', 'ProfilePage']),
    );
  });

  it('extracts Symfony routes and resolves controller action references', () => {
    const ctx = context(
      {
        'composer.json': JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } }),
        'config/routes.yaml': '',
      },
      [
        node({
          id: 'class:order-controller',
          kind: 'class',
          name: 'OrderController',
          qualifiedName: 'App\\Controller\\OrderController',
          filePath: 'src/Controller/OrderController.php',
          language: 'php',
        }),
        node({
          id: 'method:show',
          kind: 'method',
          name: 'show',
          filePath: 'src/Controller/OrderController.php',
          language: 'php',
        }),
      ],
    );
    expect(symfonyResolver.detect(ctx)).toBe(true);

    const yamlResult = symfonyResolver.extract!(
      'config/routes.yaml',
      `
orders_show:
  path: /orders/{id}
  controller: App\\Controller\\OrderController::show
`,
    );
    expect(yamlResult.nodes[0]).toMatchObject({ kind: 'route', name: 'orders_show', signature: '/orders/{id}' });
    expect(yamlResult.references[0]?.referenceName).toBe('App\\Controller\\OrderController::show');
    expect(symfonyResolver.resolve(ref('App\\Controller\\OrderController::show'), ctx)).toMatchObject({
      targetNodeId: 'method:show',
      confidence: 0.9,
      resolvedBy: 'framework',
    });

    const phpResult = symfonyResolver.extract!(
      'src/Controller/OrderController.php',
      `<?php
use Symfony\\Component\\Routing\\Attribute\\Route;
class OrderController {
  #[Route('/orders/{id}', name: 'orders_show', methods: ['GET'])]
  public function show() {}
}
`,
    );
    expect(phpResult.nodes[0]).toMatchObject({ kind: 'route', name: 'orders_show' });
    expect(phpResult.references[0]?.referenceName).toBe('show');
  });

  it('detects NeuG and extracts graph resource landmarks', () => {
    const ctx = context({
      'pyproject.toml': '[project]\ndependencies = ["neug"]\n',
      'graph.py': 'import neug\n',
    });
    expect(neugResolver.detect(ctx)).toBe(true);

    const nodes = neugResolver.extractNodes!(
      'graph.py',
      `
import neug
graph = neug.Graph("catalog")
users = neug.Vertex("User")
likes = neug.Edge("LIKES")
`,
    );

    expect(nodes.map((n) => `${n.kind}:${n.name}`)).toEqual(
      expect.arrayContaining(['resource:neug:graph:catalog', 'resource:neug:vertex:User', 'resource:neug:edge:LIKES']),
    );
  });
});
