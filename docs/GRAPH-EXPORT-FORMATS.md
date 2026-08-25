# Graph export formats

[Documentation home](README.md) · [Project overview](../README.md) ·
[CLI reference](CLI-REFERENCE.md) · [Architecture](v2/ARCHITECTURE.md)

The browser visual-graph viewer is not part of v2, but graph data and diagram
interchange remain first-class. `cartograph export` reads one current-generation
snapshot, applies filters, caps nodes, and removes edges whose endpoints are not
in the exported set.

```sh
cartograph export --format json --limit 1000
cartograph export --format dot --kind class,method --edge-kind calls --out graph.dot
cartograph export --format mermaid --file src/billing --out billing.mmd
cartograph export --format cytoscape --language typescript --out graph.cy.json
```

## Versioned JSON

JSON and Cytoscape exports use `formatVersion: 1`. Optional fields may be added
within a version; renaming/removing fields or changing their meaning requires a
new version.

```text
{
  formatVersion: 1,
  generationId: string,
  filters: {
    kinds: string[],
    edgeKinds: string[],
    languages: string[],
    filePrefix?: string
  },
  stats: {
    totalNodes: number,
    totalEdges: number,
    exportedNodes: number,
    exportedEdges: number,
    exportedFiles: number,
    truncatedNodes: number
  },
  nodes: GraphExportNode[],
  edges: GraphExportEdge[],
  files: GraphExportFile[]
}
```

Nodes contain `id`, `kind`, `name`, `qualifiedName`, `signature`, `filePath`,
`language`, `startLine`, and `endLine`. Edges contain `source`, `target`,
`kind`, numeric `confidence`, `provenance`, and represented `siteCount`. Files
contain `path`, `language`, and `nodeCount`.

Cytoscape output wraps the same node data under `elements.nodes[].data` and
adds deterministic edge IDs/labels under `elements.edges[].data`. DOT and
Mermaid are presentation formats; their labels may improve without changing
the selected membership semantics.

The default cap is 1,000 nodes and the accepted maximum is 50,000. Filters are
exact comma-separated kind/edge/language values, with a normalized
project-relative file prefix. `stats.truncatedNodes` and the generation ID make
partial/stale downstream interpretation explicit.

For standardized code-intelligence interchange, use `cartograph admin
scip-export`/`scip-import`. SCIP retains definitions, occurrences,
documentation, relationships, and Cartograph's forward-compatible exact typed
edge/site-count extension.
