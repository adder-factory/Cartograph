/**
 * Probe — debug friction #20: complex_method metric inflated for
 * trivial functions. Walks the AST under the bodyNode and prints
 * its full structure, plus checks for parser errors / missing nodes.
 */

import * as fs from 'fs';
import { findNodeInTree, parseSource, computeMetrics } from '../src/biomarkers/engine.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';

await initGrammars();
await loadAllGrammars();

const src = fs.readFileSync('src/installer/pool-cli.ts', 'utf8');
const tree = parseSource(src, 'typescript');
if (!tree) {
  console.error('parse failed');
  process.exit(1);
}

console.log(`tree.rootNode.hasError = ${tree.rootNode.hasError}`);
console.log(`tree.rootNode.type = ${tree.rootNode.type}`);

// Find every error_node anywhere in the tree
let errorCount = 0;
let missingCount = 0;
const errorStack = [tree.rootNode];
while (errorStack.length > 0) {
  const n = errorStack.pop()!;
  if (n.type === 'ERROR' || n.isError) errorCount++;
  if (n.isMissing) missingCount++;
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (c) errorStack.push(c);
  }
}
console.log(`error nodes: ${errorCount}, missing nodes: ${missingCount}`);

const node = findNodeInTree(tree, 245, 7);
if (!node) {
  console.error('findNodeInTree returned null');
  process.exit(1);
}
console.log(
  `runPoolStatusCli node: type=${node.type} startRow=${node.startPosition.row + 1} endRow=${node.endPosition.row + 1}`,
);

// Walk THE WHOLE SUBTREE under bodyNode and print every branching/nesting hit
const BRANCH_KINDS = new Set([
  'if_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'switch_case',
  'switch_default',
  'catch_clause',
  'ternary_expression',
]);

const stack = [{ node, depth: 0 }];
let cyc = 1;
const branches: Array<{ row: number; type: string }> = [];
while (stack.length > 0) {
  const { node: n, depth } = stack.pop()!;
  if (BRANCH_KINDS.has(n.type)) {
    cyc++;
    branches.push({ row: n.startPosition.row + 1, type: n.type });
  }
  for (let i = n.childCount - 1; i >= 0; i--) {
    const c = n.child(i);
    if (c) stack.push({ node: c, depth: depth + 1 });
  }
}
console.log(`cyc total: ${cyc}, branch count: ${branches.length}`);
for (const b of branches.slice(0, 30)) {
  console.log(`  L${b.row}: ${b.type}`);
}
