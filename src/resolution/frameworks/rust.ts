/**
 * Rust Framework Resolver
 *
 * Handles Actix-web, Rocket, Axum, and common Rust patterns.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types.js';
import { stripCommentsForRegex, makeLineIndex } from '../../utils.js';
import { resolveByNameAndKind } from './resolve-by-name.js';
import { clearCargoWorkspaceCache, getCargoWorkspaceCrateMap } from './cargo-workspace.js';

export const rustResolver: FrameworkResolver = {
  name: 'rust',

  detect(context: ResolutionContext): boolean {
    // Check for Cargo.toml (Rust project signature)
    return context.fileExists('Cargo.toml');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Handler references
    if (ref.referenceName.endsWith('_handler') || ref.referenceName.startsWith('handle_')) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kinds: FUNCTION_KINDS,
        preferredDirPatterns: HANDLER_DIRS,
        context,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Service/Repository trait implementations
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kinds: SERVICE_KINDS,
        preferredDirPatterns: SERVICE_DIRS,
        context,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Struct references (PascalCase)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kinds: STRUCT_KINDS,
        preferredDirPatterns: MODEL_DIRS,
        context,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Module references
    if (/^[a-z_]+$/.test(ref.referenceName)) {
      const result = resolveModule(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result.targetNodeId,
          confidence: result.confidence,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  languages: ['rust'],

  clearCache(context: ResolutionContext): void {
    clearCargoWorkspaceCache(context);
  },

  extractNodes(filePath: string, content: string, getStripped?: () => string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    // Strip `//` and `/* */` comments so doc-comment examples like
    // `/// #[get("/x")]` aren't treated as real route attributes.
    const safe = getStripped ? getStripped() : stripCommentsForRegex(content, 'rust');
    const lineOf = makeLineIndex(safe);

    // Extract Actix-web routes
    // #[get("/path")], #[post("/path")], etc.
    const actixRoutePattern = /#\[(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

    let match: RegExpExecArray | null;
    while ((match = actixRoutePattern.exec(safe)) !== null) {
      const [, method, path] = match;
      const line = lineOf(match.index);

      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`,
        kind: 'route',
        name: `${method!.toUpperCase()} ${path}`,
        qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'rust',
        updatedAt: now,
      });
    }

    // Extract Rocket routes
    // #[get("/path")], #[post("/path", ...)]
    const rocketRoutePattern = /#\[(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/g;

    while ((match = rocketRoutePattern.exec(safe)) !== null) {
      const [, method, path] = match;
      const line = lineOf(match.index);

      // Avoid duplicates from actix pattern
      const routeId = `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`;
      if (!nodes.some((n) => n.id === routeId)) {
        nodes.push({
          id: routeId,
          kind: 'route',
          name: `${method!.toUpperCase()} ${path}`,
          qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'rust',
          updatedAt: now,
        });
      }
    }

    // Extract Axum routes (method chaining style)
    // .route("/path", get(handler))
    const axumRoutePattern = /\.route\s*\(\s*["']([^"']+)["']\s*,\s*(get|post|put|patch|delete)/g;

    while ((match = axumRoutePattern.exec(safe)) !== null) {
      const [, path, method] = match;
      const line = lineOf(match.index);

      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`,
        kind: 'route',
        name: `${method!.toUpperCase()} ${path}`,
        qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'rust',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Directory patterns
const HANDLER_DIRS = ['/handlers/', '/handler/', '/api/', '/routes/', '/controllers/'];
const SERVICE_DIRS = ['/services/', '/service/', '/repository/', '/domain/'];
const MODEL_DIRS = ['/models/', '/model/', '/entities/', '/entity/', '/domain/', '/types/'];

const FUNCTION_KINDS = new Set(['function']);
const SERVICE_KINDS = new Set(['struct', 'trait']);
const STRUCT_KINDS = new Set(['struct']);
const WORKSPACE_CRATE_CONFIDENCE = 0.85;
const RUST_MODULE_FILE_CONFIDENCE = 0.6;

function resolveModule(name: string, context: ResolutionContext): { targetNodeId: string; confidence: number } | null {
  const workspaceCrate = resolveWorkspaceCrate(name, context);
  if (workspaceCrate) return { targetNodeId: workspaceCrate, confidence: WORKSPACE_CRATE_CONFIDENCE };

  // Rust modules can be either mod.rs in a directory or name.rs
  const possiblePaths = [`src/${name}.rs`, `src/${name}/mod.rs`];

  for (const modPath of possiblePaths) {
    if (context.fileExists(modPath)) {
      const nodes = context.getNodesInFile(modPath);
      const modNode = nodes.find((n) => n.kind === 'module');
      if (modNode) {
        return { targetNodeId: modNode.id, confidence: RUST_MODULE_FILE_CONFIDENCE };
      }
      // If no explicit module node, return the first node in the file
      if (nodes.length > 0) {
        return { targetNodeId: nodes[0]!.id, confidence: RUST_MODULE_FILE_CONFIDENCE };
      }
    }
  }

  return null;
}

function resolveWorkspaceCrate(name: string, context: ResolutionContext): string | null {
  const memberPath = getCargoWorkspaceCrateMap(context).get(name);
  if (!memberPath) return null;

  for (const crateRoot of [`${memberPath}/src/lib.rs`, `${memberPath}/src/main.rs`, `${memberPath}/src/mod.rs`]) {
    if (!context.fileExists(crateRoot)) continue;
    const nodes = context.getNodesInFile(crateRoot);
    const moduleNode = nodes.find((n) => n.kind === 'module');
    if (moduleNode) return moduleNode.id;
    const firstSymbol = nodes.find((n) => n.kind !== 'file');
    if (firstSymbol) return firstSymbol.id;
    if (nodes[0]) return nodes[0].id;
  }

  return null;
}
