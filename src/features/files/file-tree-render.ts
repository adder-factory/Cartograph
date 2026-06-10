/**
 * ASCII file-tree renderer for the `files` feature slice (consumed by
 * `features/files/runtime.ts`, which drives both the MCP and CLI file
 * listings). Generic over the node type (`TNode`) and the per-leaf action
 * (MCP pushes to a `string[]`; the CLI logs with chalk colouring), so the
 * prefix / indent / last-child recursion lives in exactly one place.
 */

/** A node in the indexed-file path-trie. */
export interface FileTreeNode {
  name: string;
  children: Map<string, FileTreeNode>;
  /** Set on leaf nodes only — the indexed file's language + symbol count. */
  file?: { language: string; nodeCount: number };
}

/** Input row for {@link buildFileTree} — a file path plus the metadata
 *  the renderer shows on its leaf. */
export interface FileTreeInput {
  path: string;
  language: string;
  nodeCount: number;
}

/**
 * Build the path-trie of indexed files. Each path is `/`-split and
 * walked segment by segment, creating directory nodes on demand; the
 * final segment carries the leaf's `file` metadata. Shared by the MCP
 * `cartograph_files` tool and the `cartograph files` CLI so the two
 * surfaces build identical trees.
 */
export function buildFileTree(files: ReadonlyArray<FileTreeInput>): FileTreeNode {
  const root: FileTreeNode = { name: '', children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;
      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }
  return root;
}

/** Sort comparator: directories before files, both alphabetically.
 *  A node is "a directory" iff it has children AND no file metadata
 *  (a leaf with metadata is the file itself). */
export function compareFileTreeChildren(a: FileTreeNode, b: FileTreeNode): number {
  const aIsDir = a.children.size > 0 && !a.file;
  const bIsDir = b.children.size > 0 && !b.file;
  if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export interface RecurseChildrenArgs<TExtra> {
  prefix: string;
  childPrefix: string;
  depth: number;
  includeMetadata: boolean;
  maxDepth: number | undefined;
  parentName: string;
  /** Caller-supplied extra context forwarded unchanged to renderChild. */
  extra: TExtra;
}

/**
 * Recurse into each child node of a file-tree.
 *
 * @param children   Sorted array of child nodes.
 * @param args       Shared prefix/depth/metadata state + caller extra context.
 * @param renderChild  Callback invoked for each child; must call
 *                     `recurseFileTreeChildren` (or this function) for its
 *                     own children to continue the traversal.
 */
export function recurseFileTreeChildren<TNode extends FileTreeNode, TExtra>(
  children: TNode[],
  args: RecurseChildrenArgs<TExtra>,
  renderChild: (node: TNode, childArgs: RecurseChildrenArgs<TExtra>, isLast: boolean) => void,
): void {
  const { prefix, childPrefix, depth, includeMetadata, maxDepth, extra, parentName } = args;
  const indented = prefix + childPrefix;
  const childPrefixForChild = parentName ? indented : prefix;
  const lastIdx = children.length - 1;
  children.forEach((child, i) => {
    renderChild(
      child,
      {
        prefix: childPrefixForChild,
        childPrefix,
        depth: depth + 1,
        includeMetadata,
        maxDepth,
        parentName: child.name,
        extra,
      },
      i === lastIdx,
    );
  });
}
