/**
 * C# Framework Resolver
 *
 * Handles ASP.NET Core, ASP.NET MVC, and common C# patterns.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types.js';
import { stripCommentsForRegex, makeLineIndex } from '../../utils.js';
import { resolveByNameAndKind } from './resolve-by-name.js';

export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',
  // F#73 — the resolver scans for `[HttpGet]` / `[HttpPost]` / ...
  // attribute brackets PLUS the minimal-API `MapGet(...)` /
  // `MapPost(...)` calls. Listing both anchor families skips files
  // (DTOs, plain services) that don't carry any route surface.
  anchors: [
    '[HttpGet',
    '[HttpPost',
    '[HttpPut',
    '[HttpPatch',
    '[HttpDelete',
    '[Route',
    // No trailing `(`: the minimal-API regex tolerates whitespace before
    // the paren (`app.MapGet ("/x")`), so anchoring on `.MapGet` (not
    // `.MapGet(`) keeps the pre-filter from skipping that whitespace style.
    '.MapGet',
    '.MapPost',
    '.MapPut',
    '.MapPatch',
    '.MapDelete',
  ],

  detect(context: ResolutionContext): boolean {
    // Check for .csproj files with ASP.NET references
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.csproj')) {
        const content = context.readFile(file);
        if (
          content &&
          (content.includes('Microsoft.AspNetCore') ||
            content.includes('Microsoft.NET.Sdk.Web') ||
            content.includes('System.Web.Mvc'))
        ) {
          return true;
        }
      }
    }

    // Check for Program.cs with WebApplication
    const programCs = context.readFile('Program.cs');
    if (
      programCs &&
      (programCs.includes('WebApplication') ||
        programCs.includes('CreateHostBuilder') ||
        programCs.includes('UseStartup'))
    ) {
      return true;
    }

    // Check for Startup.cs (ASP.NET Core signature)
    if (context.fileExists('Startup.cs')) {
      return true;
    }

    // Check for Controllers directory
    return allFiles.some((f) => f.includes('/Controllers/') && f.endsWith('Controller.cs'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    return resolveAspnetConvention(ref, context);
  },

  languages: ['csharp'],

  extractNodes(filePath: string, content: string, getStripped?: () => string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    // Strip `//` and `/* */` comments so XML-doc examples like
    // `/// [HttpGet("/x")]` aren't treated as real route attributes.
    const safe = getStripped ? getStripped() : stripCommentsForRegex(content, 'csharp');
    const lineOf = makeLineIndex(safe);

    // Extract route attributes
    // [HttpGet("path")], [HttpPost("path")], [Route("path")]
    const routePatterns = [
      /\[(Http(Get|Post|Put|Patch|Delete))\s*\(\s*["']([^"']+)["']\s*\)\]/g,
      /\[(Http(Get|Post|Put|Patch|Delete))\s*\]/g,
      /\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/g,
    ];

    for (const pattern of routePatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(safe)) !== null) {
        const line = lineOf(match.index);

        if (pattern.source.includes('Http')) {
          if (match[3]) {
            // HttpGet("path") style
            const [, , method, path] = match;
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
              language: 'csharp',
              updatedAt: now,
            });
          } else if (match[2]) {
            // HttpGet style without path
            const [, , method] = match;
            nodes.push({
              id: `route:${filePath}:${method.toUpperCase()}:${line}`,
              kind: 'route',
              name: `${method.toUpperCase()}`,
              qualifiedName: `${filePath}::${method.toUpperCase()}`,
              filePath,
              startLine: line,
              endLine: line,
              startColumn: 0,
              endColumn: match[0].length,
              language: 'csharp',
              updatedAt: now,
            });
          }
        } else {
          // [Route("path")] style
          const [, path] = match;
          nodes.push({
            id: `route:${filePath}:ROUTE:${path}:${line}`,
            kind: 'route',
            name: `ROUTE ${path}`,
            qualifiedName: `${filePath}::ROUTE:${path}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'csharp',
            updatedAt: now,
          });
        }
      }
    }

    // Extract minimal API routes (ASP.NET Core 6+)
    // app.MapGet("/path", ...), app.MapPost("/path", ...)
    const minimalApiPattern = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']/g;

    let match: RegExpExecArray | null;
    while ((match = minimalApiPattern.exec(safe)) !== null) {
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
        language: 'csharp',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

interface AspnetConventionRule {
  matches(name: string): boolean;
  kinds: Set<string>;
  preferredDirPatterns: string[];
  confidence: number;
}

function resolveAspnetConvention(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  for (const rule of ASPNET_CONVENTION_RULES) {
    if (!rule.matches(ref.referenceName)) continue;
    const result = resolveByNameAndKind({
      name: ref.referenceName,
      kinds: rule.kinds,
      preferredDirPatterns: rule.preferredDirPatterns,
      context,
    });
    if (result) return { original: ref, targetNodeId: result, confidence: rule.confidence, resolvedBy: 'framework' };
  }
  return null;
}

// Directory patterns
const CONTROLLER_DIRS = ['/Controllers/'];
const SERVICE_DIRS = ['/Services/', '/Service/', '/Application/'];
const REPO_DIRS = ['/Repositories/', '/Repository/', '/Data/', '/Infrastructure/'];
const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Entity/', '/Domain/'];
const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/DTOs/', '/Dto/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);

const ASPNET_CONVENTION_RULES: AspnetConventionRule[] = [
  {
    matches: (name) => name.endsWith('Controller'),
    kinds: CLASS_KINDS,
    preferredDirPatterns: CONTROLLER_DIRS,
    confidence: 0.85,
  },
  {
    matches: (name) => name.endsWith('Service') || (name.startsWith('I') && name.length > 1),
    kinds: SERVICE_KINDS,
    preferredDirPatterns: SERVICE_DIRS,
    confidence: 0.85,
  },
  {
    matches: (name) => name.endsWith('Repository'),
    kinds: SERVICE_KINDS,
    preferredDirPatterns: REPO_DIRS,
    confidence: 0.85,
  },
  {
    matches: (name) => /^[A-Z][a-zA-Z]+$/.test(name),
    kinds: CLASS_KINDS,
    preferredDirPatterns: MODEL_DIRS,
    confidence: 0.7,
  },
  {
    matches: (name) => name.endsWith('ViewModel') || name.endsWith('Dto'),
    kinds: CLASS_KINDS,
    preferredDirPatterns: VIEWMODEL_DIRS,
    confidence: 0.8,
  },
];
