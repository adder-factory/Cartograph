/**
 * Java Framework Resolver
 *
 * Handles Spring Boot and general Java patterns.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types.js';
import { resolveByNameAndKind } from './resolve-by-name.js';
import { makeLineIndex } from '../../utils.js';

export const springResolver: FrameworkResolver = {
  name: 'spring',
  // F#73 — every regex pattern requires one of `@GetMapping` /
  // `@PostMapping` / `@PutMapping` / `@PatchMapping` / `@DeleteMapping`
  // / `@RequestMapping`. Listing them as anchors lets the dispatcher
  // skip files (test fixtures, plain POJOs) with no Spring routes.
  anchors: ['@GetMapping', '@PostMapping', '@PutMapping', '@PatchMapping', '@DeleteMapping', '@RequestMapping'],

  detect(context: ResolutionContext): boolean {
    // Check for pom.xml with Spring
    const pomXml = context.readFile('pom.xml');
    if (pomXml && (pomXml.includes('spring-boot') || pomXml.includes('springframework'))) {
      return true;
    }

    // Check for build.gradle with Spring
    const buildGradle = context.readFile('build.gradle');
    if (buildGradle && (buildGradle.includes('spring-boot') || buildGradle.includes('springframework'))) {
      return true;
    }

    const buildGradleKts = context.readFile('build.gradle.kts');
    if (buildGradleKts && (buildGradleKts.includes('spring-boot') || buildGradleKts.includes('springframework'))) {
      return true;
    }

    // Check for Spring annotations in Java files
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.java')) {
        const content = context.readFile(file);
        if (
          content &&
          (content.includes('@SpringBootApplication') ||
            content.includes('@RestController') ||
            content.includes('@Service') ||
            content.includes('@Repository'))
        ) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Service references (dependency injection)
    if (ref.referenceName.endsWith('Service')) {
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
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Repository references
    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kinds: SERVICE_KINDS,
        preferredDirPatterns: REPO_DIRS,
        context,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kinds: CLASS_KINDS,
        preferredDirPatterns: CONTROLLER_DIRS,
        context,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Entity/Model references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kinds: CLASS_KINDS,
        preferredDirPatterns: ENTITY_DIRS,
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

    // Pattern 5: Component references
    if (ref.referenceName.endsWith('Component') || ref.referenceName.endsWith('Config')) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kinds: CLASS_KINDS,
        preferredDirPatterns: COMPONENT_DIRS,
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

    return null;
  },

  languages: ['java', 'kotlin'],

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const lineOf = makeLineIndex(content);

    // Extract REST endpoints
    // @GetMapping("/path"), @PostMapping("/path"), etc.
    const mappingPatterns = [
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g,
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:path\s*=\s*)?["']([^"']+)["']/g,
    ];

    for (const pattern of mappingPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const [, mappingType, path] = match;
        const line = lineOf(match.index);

        const method = mappingType === 'Request' ? 'ANY' : mappingType!.toUpperCase();

        nodes.push({
          id: `route:${filePath}:${method}:${path}:${line}`,
          kind: 'route',
          name: `${method} ${path}`,
          qualifiedName: `${filePath}::${method}:${path}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'java',
          updatedAt: now,
        });
      }
    }

    // Extract class-level @RequestMapping for base path
    const baseMappingMatch = content.match(/@RequestMapping\s*\(\s*["']([^"']+)["']\s*\)/);
    if (baseMappingMatch) {
      const [, basePath] = baseMappingMatch;
      // `String.prototype.match` is typed as returning `index?: number`
      // but a successful non-global match always sets it; assert.
      const line = lineOf(baseMappingMatch.index!);

      nodes.push({
        id: `route:${filePath}:BASE:${basePath}:${line}`,
        kind: 'route',
        name: `BASE ${basePath}`,
        qualifiedName: `${filePath}::BASE:${basePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: baseMappingMatch[0].length,
        language: 'java',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Directory patterns
const SERVICE_DIRS = ['/service/', '/services/'];
const REPO_DIRS = ['/repository/', '/repositories/'];
const CONTROLLER_DIRS = ['/controller/', '/controllers/'];
const ENTITY_DIRS = ['/entity/', '/entities/', '/model/', '/models/', '/domain/'];
const COMPONENT_DIRS = ['/component/', '/components/', '/config/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);
