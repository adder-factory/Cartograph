import { describe, it, expect } from 'vitest';
import { swiftUIResolver, uikitResolver, vaporResolver } from '../src/resolution/frameworks/swift.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import type { Language, Node, NodeKind } from '../src/types.js';

function node(id: string, name: string, kind: NodeKind, filePath: string): Node {
  return {
    id,
    name,
    kind,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'swift',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: name.length,
  };
}

function ref(referenceName: string): UnresolvedRef {
  return {
    fromNodeId: 'source',
    referenceName,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: 'Sources/App.swift',
    language: 'swift',
  };
}

function context(files: Record<string, string>, nodes: Node[] = []): ResolutionContext {
  return {
    getNodesInFile: (filePath: string) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qualifiedName: string) => nodes.filter((n) => n.qualifiedName === qualifiedName),
    getNodesByKind: (kind: NodeKind) => nodes.filter((n) => n.kind === kind),
    fileExists: (filePath: string) => Object.hasOwn(files, filePath),
    readFile: (filePath: string) => files[filePath] ?? null,
    getProjectRoot: () => '/tmp/swift-project',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: (lowerName: string) => nodes.filter((n) => n.name.toLowerCase() === lowerName),
    getImportMappings: (_filePath: string, _language: Language) => [],
  };
}

describe('Swift framework resolvers', () => {
  it('detects SwiftUI, UIKit, and Vapor from real project signals', () => {
    expect(swiftUIResolver.detect(context({ 'Sources/App.swift': 'import SwiftUI\nstruct ContentView: View {}' }))).toBe(
      true,
    );
    expect(swiftUIResolver.detect(context({ 'Cartograph.xcodeproj': '' }))).toBe(true);

    expect(uikitResolver.detect(context({ 'Sources/Profile.swift': 'import UIKit\nclass ProfileView: UIView {}' }))).toBe(
      true,
    );

    expect(vaporResolver.detect(context({ 'Package.swift': '.package(url: "https://github.com/vapor/vapor")' }))).toBe(
      true,
    );
    expect(vaporResolver.detect(context({ 'Sources/routes.swift': 'import Vapor\nfunc routes(_ app: Application) {}' }))).toBe(
      true,
    );
  });

  it('extracts SwiftUI app/view nodes, UIKit class nodes, and Vapor routes', () => {
    const swiftUiNodes = swiftUIResolver.extractNodes!(
      'Sources/App.swift',
      ['import SwiftUI', '@main struct CartographApp: App {}', 'struct ContentView: View {}'].join('\n'),
    );
    expect(swiftUiNodes.map((n) => [n.kind, n.name])).toEqual([
      ['component', 'ContentView'],
      ['class', 'CartographApp'],
    ]);

    const uiKitNodes = uikitResolver.extractNodes!(
      'Sources/ProfileViewController.swift',
      ['class ProfileViewController: UIViewController {}', 'class AvatarView: UIView {}'].join('\n'),
    );
    expect(uiKitNodes.map((n) => [n.kind, n.name])).toEqual([
      ['class', 'ProfileViewController'],
      ['class', 'AvatarView'],
    ]);

    const vaporNodes = vaporResolver.extractNodes!(
      'Sources/routes.swift',
      ['app.get("health") { req in }', 'app.grouped("api").post("users") { req in }'].join('\n'),
    );
    expect(vaporNodes.map((n) => n.name)).toEqual(['GET health', 'POST users', 'POST /api/users']);
  });

  it('resolves SwiftUI references using framework-preferred directories', () => {
    const nodes = [
      node('plain-view', 'HomeView', 'component', 'Sources/Generated/HomeView.swift'),
      node('preferred-view', 'HomeView', 'component', 'Sources/Views/HomeView.swift'),
      node('preferred-store', 'SessionStore', 'class', 'Sources/Stores/SessionStore.swift'),
      node('preferred-model', 'Account', 'struct', 'Sources/Models/Account.swift'),
    ];
    const ctx = context({}, nodes);

    expect(swiftUIResolver.resolve(ref('HomeView'), ctx)).toMatchObject({
      targetNodeId: 'preferred-view',
      confidence: 0.85,
      resolvedBy: 'framework',
    });
    expect(swiftUIResolver.resolve(ref('SessionStore'), ctx)).toMatchObject({
      targetNodeId: 'preferred-store',
      confidence: 0.85,
    });
    expect(swiftUIResolver.resolve(ref('Account'), ctx)).toMatchObject({
      targetNodeId: 'preferred-model',
      confidence: 0.7,
    });
    expect(swiftUIResolver.resolve(ref('homeView'), ctx)).toBeNull();
  });

  it('resolves UIKit and Vapor references by framework conventions', () => {
    const nodes = [
      node('vc', 'ProfileViewController', 'class', 'Sources/ViewControllers/ProfileViewController.swift'),
      node('view', 'AvatarView', 'class', 'Sources/UI/AvatarView.swift'),
      node('cell', 'UserCell', 'class', 'Sources/TableViewCells/UserCell.swift'),
      node('delegate', 'ProfileDelegate', 'protocol', 'Sources/ProfileDelegate.swift'),
      node('controller', 'UserController', 'struct', 'Sources/Controllers/UserController.swift'),
      node('model', 'User', 'class', 'Sources/Models/User.swift'),
    ];
    const ctx = context({}, nodes);

    expect(uikitResolver.resolve(ref('ProfileViewController'), ctx)).toMatchObject({ targetNodeId: 'vc' });
    expect(uikitResolver.resolve(ref('AvatarView'), ctx)).toMatchObject({ targetNodeId: 'view', confidence: 0.8 });
    expect(uikitResolver.resolve(ref('UserCell'), ctx)).toMatchObject({ targetNodeId: 'cell' });
    expect(uikitResolver.resolve(ref('ProfileDelegate'), ctx)).toMatchObject({
      targetNodeId: 'delegate',
      confidence: 0.8,
    });

    expect(vaporResolver.resolve(ref('UserController'), ctx)).toMatchObject({
      targetNodeId: 'controller',
      confidence: 0.85,
    });
    expect(vaporResolver.resolve(ref('User'), ctx)).toMatchObject({ targetNodeId: 'model', confidence: 0.75 });
  });
});
