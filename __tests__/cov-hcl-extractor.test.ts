/**
 * Coverage tests for src/extraction/hcl-extractor.ts
 *
 * The HclExtractor turns Terraform/HCL source into graph nodes/edges:
 *   - resource / data  -> resource nodes (two labels)
 *   - variable          -> variable node (var.X)
 *   - output            -> export node (output.X)
 *   - provider          -> namespace node (provider.X)
 *   - module            -> module node (module.X) + imports edge for `source`
 *   - locals            -> one constant per attribute (local.X)
 *   - terraform         -> single module node (qn "terraform")
 *   - unknown block     -> namespace fallback (<kind>.<label>)
 *
 * References inside attribute values become `references` unresolved refs,
 * Terraform built-in heads (count/each/self/path/terraform/null/true/false)
 * and for-loop iteration bindings are suppressed.
 *
 * These tests drive the extractor through `extractFromSource` (the public
 * entry the rest of the codebase uses) with realistic HCL fixtures and
 * assert the concrete node kinds / names / qualified names / edges and the
 * emitted unresolved references.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { initGrammars, loadAllGrammars, detectLanguage } from '../src/extraction/grammars.js';
import type { ExtractionResult } from '../src/extraction/types.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extract(code: string, file = 'main.tf'): ExtractionResult {
  return extractFromSource(file, code);
}

function refNames(result: ExtractionResult): string[] {
  return result.unresolvedReferences.map((r) => r.referenceName);
}

function refsOfKind(result: ExtractionResult, kind: string): string[] {
  return result.unresolvedReferences.filter((r) => r.referenceKind === kind).map((r) => r.referenceName);
}

function nodeByQn(result: ExtractionResult, qn: string) {
  return result.nodes.find((n) => n.qualifiedName === qn);
}

// Sanity: confirm the file routes to the HCL extractor at all.
describe('HclExtractor — wiring', () => {
  it('routes .tf / .hcl / .tofu / .tfvars to the hcl language', () => {
    expect(detectLanguage('main.tf')).toBe('hcl');
    expect(detectLanguage('vars.tfvars')).toBe('hcl');
    expect(detectLanguage('config.hcl')).toBe('hcl');
    expect(detectLanguage('main.tofu')).toBe('hcl');
  });

  it('always emits a file node tagged language=hcl', () => {
    const result = extract('resource "aws_s3_bucket" "logs" {}');
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.language).toBe('hcl');
  });
});

// ---------------------------------------------------------------------------
// Block emission — kinds, names, qualified names, signatures, positions
// ---------------------------------------------------------------------------

describe('HclExtractor — typed blocks (resource / data)', () => {
  it('emits a resource node with TYPE.NAME name and no qn prefix', () => {
    const result = extract(`resource "aws_s3_bucket" "logs" {
  bucket = "my-logs"
}`);
    const node = nodeByQn(result, 'aws_s3_bucket.logs');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('resource');
    expect(node?.name).toBe('aws_s3_bucket.logs');
    expect(node?.signature).toBe('resource "aws_s3_bucket" "logs"');
    expect(node?.language).toBe('hcl');
    // multi-line block spans more than one line
    expect(node!.endLine).toBeGreaterThan(node!.startLine);
    // 0-based AST row -> 1-based startLine
    expect(node?.startLine).toBe(1);
  });

  it('emits a data node with the `data.` qn prefix', () => {
    const result = extract('data "aws_caller_identity" "current" {}');
    const node = nodeByQn(result, 'data.aws_caller_identity.current');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('resource');
    expect(node?.name).toBe('aws_caller_identity.current');
    expect(node?.signature).toBe('data "aws_caller_identity" "current"');
  });

  it('drops a resource block that is missing its second (NAME) label', () => {
    // Only one label -> hclEmitTypedBlock returns early (labels.length < 2).
    const result = extract('resource "aws_s3_bucket" {}');
    const resources = result.nodes.filter((n) => n.kind === 'resource');
    expect(resources.length).toBe(0);
  });

  it('connects each block to the file via a contains edge', () => {
    const result = extract('resource "aws_s3_bucket" "logs" {}');
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    const resourceNode = nodeByQn(result, 'aws_s3_bucket.logs');
    expect(fileNode && resourceNode).toBeTruthy();
    const edge = result.edges.find(
      (e) => e.source === fileNode!.id && e.target === resourceNode!.id && e.kind === 'contains',
    );
    expect(edge).toBeDefined();
  });
});

describe('HclExtractor — named blocks (variable / output / provider / module)', () => {
  it('emits a variable node as kind=variable with var. prefix', () => {
    const result = extract('variable "environment" {\n  type = string\n  default = "dev"\n}');
    const node = nodeByQn(result, 'var.environment');
    expect(node?.kind).toBe('variable');
    expect(node?.name).toBe('environment');
    expect(node?.signature).toBe('variable "environment"');
  });

  it('emits an output node as kind=export with output. prefix', () => {
    const result = extract('output "vpc_id" { value = "abc" }');
    const node = nodeByQn(result, 'output.vpc_id');
    expect(node?.kind).toBe('export');
    expect(node?.name).toBe('vpc_id');
  });

  it('emits a provider node as kind=namespace with provider. prefix', () => {
    const result = extract('provider "aws" { region = "us-east-1" }');
    const node = nodeByQn(result, 'provider.aws');
    expect(node?.kind).toBe('namespace');
    expect(node?.name).toBe('aws');
  });

  it('emits a module node as kind=module with module. prefix', () => {
    const result = extract('module "vpc" { source = "terraform-aws-modules/vpc/aws" }');
    const node = nodeByQn(result, 'module.vpc');
    expect(node?.kind).toBe('module');
    expect(node?.name).toBe('vpc');
  });

  it('drops a named block with zero labels', () => {
    // `variable {}` (no label) -> hclEmitNamedBlock returns early.
    const result = extract('variable {}');
    expect(result.nodes.filter((n) => n.kind === 'variable').length).toBe(0);
  });
});

describe('HclExtractor — unknown block kinds (namespace fallback)', () => {
  it('emits an unknown single-label block as namespace with <kind>. prefix', () => {
    // `check`, `moved`, custom blocks etc. aren't in the dispatch table.
    const result = extract('check "health" { assert { condition = true } }');
    const node = nodeByQn(result, 'check.health');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('namespace');
    expect(node?.name).toBe('health');
    expect(node?.signature).toBe('check "health"');
  });
});

describe('HclExtractor — locals', () => {
  it('splits each top-level attribute into its own constant node', () => {
    const result = extract(`locals {
  bucket_name = "my-bucket"
  retention   = 30
  enabled     = true
}`);
    const names = result.nodes
      .filter((n) => n.kind === 'constant')
      .map((n) => n.qualifiedName)
      .sort();
    expect(names).toEqual(['local.bucket_name', 'local.enabled', 'local.retention']);
    // each constant gets its own contains edge from the file
    const fileNode = result.nodes.find((n) => n.kind === 'file')!;
    const constEdges = result.edges.filter(
      (e) =>
        e.source === fileNode.id &&
        e.kind === 'contains' &&
        result.nodes.find((n) => n.id === e.target)?.kind === 'constant',
    );
    expect(constEdges.length).toBe(3);
  });

  it('records the per-attribute start line (not the block start)', () => {
    const result = extract(`locals {
  first = 1
  second = 2
}`);
    const second = nodeByQn(result, 'local.second');
    // the `second` attribute is on line 3
    expect(second?.startLine).toBe(3);
  });

  it('emits a constant node without a signature field', () => {
    const result = extract('locals {\n  a = "x"\n}');
    const a = nodeByQn(result, 'local.a');
    expect(a?.kind).toBe('constant');
    expect(a?.signature).toBeUndefined();
  });

  it('does nothing for a locals block with no body', () => {
    const result = extract('locals {}');
    expect(result.nodes.filter((n) => n.kind === 'constant').length).toBe(0);
  });
});

describe('HclExtractor — terraform block', () => {
  it('emits a single module node with qualifiedName "terraform"', () => {
    const result = extract(`terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}`);
    const node = nodeByQn(result, 'terraform');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('module');
    expect(node?.name).toBe('terraform');
    expect(node?.signature).toBe('terraform');
    // nested required_providers is NOT enumerated as its own block node
    expect(result.nodes.filter((n) => n.kind === 'module').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reference extraction — address forms and head canonicalisation
// ---------------------------------------------------------------------------

describe('HclExtractor — reference address forms', () => {
  it('extracts var.X (one segment) references', () => {
    const result = extract('resource "aws_s3_bucket" "logs" { bucket = var.bucket_name }');
    const ref = result.unresolvedReferences.find((r) => r.referenceName === 'var.bucket_name');
    expect(ref).toBeDefined();
    expect(ref?.referenceKind).toBe('references');
  });

  it('extracts local.X (one segment) references', () => {
    const result = extract('resource "aws_s3_bucket" "logs" { tags = local.common_tags }');
    expect(refNames(result)).toContain('local.common_tags');
  });

  it('truncates module.X references at the module name', () => {
    const result = extract('output "vpc_id" { value = module.vpc.vpc_id }');
    expect(refNames(result)).toContain('module.vpc');
    // the trailing attribute does NOT widen the address
    expect(refNames(result)).not.toContain('module.vpc.vpc_id');
  });

  it('extracts data.T.N references with BOTH labels (two segments)', () => {
    const result = extract('output "x" { value = data.aws_caller_identity.current.account_id }');
    expect(refNames(result)).toContain('data.aws_caller_identity.current');
    expect(refNames(result)).not.toContain('data.aws_caller_identity');
  });

  it('drops a data reference that has fewer than two segments', () => {
    // `data.foo` only has one get_attr segment -> hclFormatHclAddress returns null.
    const result = extract('output "x" { value = data.foo }');
    expect(refNames(result).find((n) => n.startsWith('data.'))).toBeUndefined();
  });

  it('extracts a resource reference as TYPE.NAME (default head, one segment)', () => {
    const result = extract('resource "aws_s3_bucket_versioning" "v" { bucket = aws_s3_bucket.logs.id }');
    expect(refNames(result)).toContain('aws_s3_bucket.logs');
  });

  it('reports the correct 1-based line/column for a reference', () => {
    const result = extract('resource "r" "n" {\n  v = var.thing\n}');
    const ref = result.unresolvedReferences.find((r) => r.referenceName === 'var.thing');
    expect(ref?.line).toBe(2);
    // `var` starts after two spaces + "v = " => column 6 (0-based)
    expect(ref?.column).toBe(6);
  });
});

describe('HclExtractor — string interpolation references', () => {
  it('extracts references from inside ${...} interpolations', () => {
    const result = extract('locals { name = "${var.environment}-${random_id.suffix.hex}" }');
    const names = refNames(result);
    expect(names).toContain('var.environment');
    expect(names).toContain('random_id.suffix');
  });
});

// ---------------------------------------------------------------------------
// Reference suppression — reserved heads & for-loop bindings
// ---------------------------------------------------------------------------

describe('HclExtractor — reserved head suppression', () => {
  it('suppresses count / each / self / path / terraform / null / true / false', () => {
    const result = extract(`resource "aws_instance" "web" {
  count   = 3
  enabled = true
  empty   = null
  off     = false
  tags = {
    Idx  = "x-\${count.index}"
    Val  = each.value
    Self = self.id
    P    = path.module
    Ws   = terraform.workspace
  }
}`);
    const names = refNames(result);
    for (const head of ['count', 'each', 'self', 'path', 'terraform', 'null', 'true', 'false']) {
      expect(names.find((n) => n === head || n.startsWith(`${head}.`))).toBeUndefined();
    }
  });
});

describe('HclExtractor — for-expression bindings', () => {
  it('suppresses the iteration var in a for_tuple_expr but keeps the iterable', () => {
    const result = extract('output "ids" { value = [for s in var.subnets : s.id] }');
    const names = refNames(result);
    expect(names).toContain('var.subnets');
    expect(names.find((n) => n === 's' || n.startsWith('s.'))).toBeUndefined();
  });

  it('suppresses key/value bindings in a for_object_expr', () => {
    const result = extract('locals { tags = { for k, v in var.input : k => "${v}-suffix" } }');
    const names = refNames(result);
    expect(names).toContain('var.input');
    expect(names.find((n) => n === 'k' || n.startsWith('k.'))).toBeUndefined();
    expect(names.find((n) => n === 'v' || n.startsWith('v.'))).toBeUndefined();
  });

  it('still extracts references from the for-intro iterable even when bindings exist', () => {
    // The iterable `var.maps` is inside the for_intro and must NOT be
    // shadowed by the bindings it introduces.
    const result = extract('locals { out = [for item in var.maps : item.id if item.enabled] }');
    const names = refNames(result);
    expect(names).toContain('var.maps');
    expect(names.find((n) => n.startsWith('item'))).toBeUndefined();
  });

  it('keeps a real reference used alongside a loop binding inside the body', () => {
    const result = extract('locals { out = [for s in var.subnets : "${s.cidr}-${var.region}"] }');
    const names = refNames(result);
    expect(names).toContain('var.subnets');
    expect(names).toContain('var.region');
    expect(names.find((n) => n.startsWith('s.'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Module source imports & static-string extraction
// ---------------------------------------------------------------------------

describe('HclExtractor — module source imports', () => {
  it('emits an imports reference for a literal module source', () => {
    const result = extract('module "vpc" { source = "terraform-aws-modules/vpc/aws" }');
    const imports = refsOfKind(result, 'imports');
    expect(imports).toContain('terraform-aws-modules/vpc/aws');
  });

  it('emits an imports reference for a quoted-template (no interpolation) source', () => {
    // `source = "./local/module"` parses as a template_expr/quoted_template
    // with a single template_literal part.
    const result = extract('module "local_mod" { source = "./modules/network" }');
    expect(refsOfKind(result, 'imports')).toContain('./modules/network');
  });

  it('does NOT emit an imports reference when source is interpolated/dynamic', () => {
    // hclExtractStaticString returns null on template_interpolation.
    const result = extract('module "m" { source = "./modules/${var.region}" }');
    expect(refsOfKind(result, 'imports').length).toBe(0);
    // but the interpolated var.region is still a normal reference
    expect(refNames(result)).toContain('var.region');
  });

  it('does NOT emit an imports reference when source is a non-string expression', () => {
    // `source = local.path` -> hclExtractStaticString sees no literal/template -> null.
    const result = extract('module "m" { source = local.path }');
    expect(refsOfKind(result, 'imports').length).toBe(0);
    expect(refNames(result)).toContain('local.path');
  });

  it('does not emit imports for a module block with no source attribute', () => {
    const result = extract('module "m" { count = 2 }');
    expect(refsOfKind(result, 'imports').length).toBe(0);
  });

  it('does not emit imports for non-module blocks even with a source-like attr', () => {
    // `source` on a data block is just a regular attribute; no imports edge.
    const result = extract('resource "x" "y" { source = "./not-a-module" }');
    expect(refsOfKind(result, 'imports').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Nested blocks
// ---------------------------------------------------------------------------

describe('HclExtractor — nested blocks', () => {
  it('walks nested blocks for references without emitting child block nodes', () => {
    const result = extract(`resource "aws_s3_bucket_versioning" "v" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = var.versioning_status
    rule {
      mfa_delete = local.mfa
    }
  }
}`);
    // Only the single top-level resource block becomes a node.
    expect(result.nodes.filter((n) => n.kind === 'resource').length).toBe(1);

    const names = refNames(result);
    // references from the top-level attribute AND both nesting levels are captured
    expect(names).toContain('aws_s3_bucket.logs');
    expect(names).toContain('var.versioning_status');
    expect(names).toContain('local.mfa');
  });
});

// ---------------------------------------------------------------------------
// Multi-block files & ordering
// ---------------------------------------------------------------------------

describe('HclExtractor — realistic multi-block file', () => {
  const FIXTURE = `terraform {
  required_version = ">= 1.5"
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "bucket_prefix" {
  type = string
}

locals {
  full_name = "\${var.bucket_prefix}-\${var.region}"
  tags      = { Env = "prod" }
}

data "aws_caller_identity" "current" {}

module "network" {
  source = "./modules/network"
  region = var.region
}

resource "aws_s3_bucket" "logs" {
  bucket = local.full_name
  tags   = local.tags
}

resource "aws_s3_bucket_acl" "logs_acl" {
  bucket = aws_s3_bucket.logs.id
  acl    = "private"
}

output "bucket_arn" {
  value = aws_s3_bucket.logs.arn
}

output "account" {
  value = data.aws_caller_identity.current.account_id
}`;

  it('extracts every top-level block to a node of the expected kind', () => {
    const result = extract(FIXTURE);
    const byQn = (qn: string) => nodeByQn(result, qn);

    expect(byQn('terraform')?.kind).toBe('module');
    expect(byQn('provider.aws')?.kind).toBe('namespace');
    expect(byQn('var.region')?.kind).toBe('variable');
    expect(byQn('var.bucket_prefix')?.kind).toBe('variable');
    expect(byQn('local.full_name')?.kind).toBe('constant');
    expect(byQn('local.tags')?.kind).toBe('constant');
    expect(byQn('data.aws_caller_identity.current')?.kind).toBe('resource');
    expect(byQn('module.network')?.kind).toBe('module');
    expect(byQn('aws_s3_bucket.logs')?.kind).toBe('resource');
    expect(byQn('aws_s3_bucket_acl.logs_acl')?.kind).toBe('resource');
    expect(byQn('output.bucket_arn')?.kind).toBe('export');
    expect(byQn('output.account')?.kind).toBe('export');
  });

  it('captures cross-block references and the module import', () => {
    const result = extract(FIXTURE);
    const names = refNames(result);
    expect(names).toEqual(
      expect.arrayContaining([
        'var.region',
        'var.bucket_prefix',
        'local.full_name',
        'local.tags',
        'aws_s3_bucket.logs',
        'data.aws_caller_identity.current',
      ]),
    );
    expect(refsOfKind(result, 'imports')).toContain('./modules/network');
  });

  it('gives every non-file node a contains edge from the file node', () => {
    const result = extract(FIXTURE);
    const fileNode = result.nodes.find((n) => n.kind === 'file')!;
    const nonFile = result.nodes.filter((n) => n.kind !== 'file');
    for (const n of nonFile) {
      const edge = result.edges.find((e) => e.source === fileNode.id && e.target === n.id && e.kind === 'contains');
      expect(edge, `missing contains edge for ${n.qualifiedName}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Robustness / malformed input
// ---------------------------------------------------------------------------

describe('HclExtractor — robustness', () => {
  it('handles an empty file (file node only, no errors)', () => {
    const result = extract('');
    expect(result.nodes.find((n) => n.kind === 'file')).toBeDefined();
    expect(result.nodes.filter((n) => n.kind !== 'file').length).toBe(0);
  });

  it('handles a comment-only file', () => {
    const result = extract('# just a comment\n// another\n/* block */');
    expect(result.nodes.find((n) => n.kind === 'file')).toBeDefined();
  });

  it('does not throw on a block with no body', () => {
    const result = extract('data "aws_ami" "ubuntu" {}');
    expect(nodeByQn(result, 'data.aws_ami.ubuntu')).toBeDefined();
  });

  it('tolerates an unterminated/truncated block and still recovers the block + ref', () => {
    // Unterminated block — tree-sitter recovers; the extractor still emits
    // the resource node and the `var.x` reference, with no thrown error.
    const result = extract('resource "aws_s3_bucket" "logs" {\n  bucket = var.x\n');
    expect(result.nodes.find((n) => n.kind === 'file')).toBeDefined();
    expect(nodeByQn(result, 'aws_s3_bucket.logs')).toBeDefined();
    expect(refNames(result)).toContain('var.x');
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('recovers a sibling block placed after a clean leading comment', () => {
    const result = extract(`# leading comment
resource "aws_s3_bucket" "ok" {
  bucket = "fine"
}`);
    expect(nodeByQn(result, 'aws_s3_bucket.ok')).toBeDefined();
  });

  it('CURRENT BEHAVIOR: a non-comment garbage prefix poisons the whole parse', () => {
    // NOTE: with a stray `???garbage???` token line, tree-sitter's HCL grammar
    // cannot recover the top-level body, so NO block nodes are produced — the
    // otherwise well-formed sibling resource is lost. Documenting current
    // behavior; this is a parser-recovery limitation, not an extractor bug.
    const result = extract(`???garbage???

resource "aws_s3_bucket" "ok" {
  bucket = "fine"
}`);
    expect(result.nodes.find((n) => n.kind === 'file')).toBeDefined();
    expect(nodeByQn(result, 'aws_s3_bucket.ok')).toBeUndefined();
    expect(result.nodes.filter((n) => n.kind !== 'file').length).toBe(0);
  });

  it('CURRENT BEHAVIOR: a bare identifier line is mis-parsed into a block label', () => {
    // `bogus line here` followed by a resource block gets re-parsed as a
    // single `bogus` block whose labels are `line`, `here`, plus the resource
    // type string — surfacing as a namespace node `bogus.aws_s3_bucket`.
    // Documenting the parse-recovery artifact (extractor faithfully reflects
    // whatever block shape tree-sitter hands it).
    const result = extract(`bogus line here
resource "aws_s3_bucket" "ok" {
  bucket = "fine"
}`);
    const namespaceNodes = result.nodes.filter((n) => n.kind === 'namespace');
    expect(namespaceNodes.length).toBe(1);
    expect(namespaceNodes[0]?.qualifiedName).toBe('bogus.aws_s3_bucket');
  });

  it('records extraction metadata (durationMs and errors array)', () => {
    const result = extract('resource "r" "n" {}');
    expect(typeof result.durationMs).toBe('number');
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
