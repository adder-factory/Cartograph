# Graph Export Formats

`cartograph export` emits a capped graph snapshot for tooling and diagrams.
The command reads the indexed `nodes`, `edges`, and `files` tables, applies
the requested filters, then drops edges whose endpoints are outside the
exported node set.

```sh
cartograph export --format json --limit 1000
cartograph export --format dot --kind class,method --edge-kind calls --out graph.dot
cartograph export --format mermaid --file src/billing --out billing.mmd
cartograph export --format cytoscape --language typescript --out graph.cy.json
```

## Versioning

The JSON and Cytoscape exports include `formatVersion: 1`.

Within a format version, Cartograph may add optional fields, but it should not
rename or remove existing fields, change their type, or alter the meaning of
`nodes`, `edges`, `files`, `filters`, or `stats`. A breaking change requires a
new `formatVersion`.

DOT and Mermaid exports are presentation formats. Their node and edge labels
may evolve for readability, but the selected graph membership follows the same
filtering and limit rules as JSON.

## JSON

`--format json` returns this top-level shape:

```ts
interface GraphExportSnapshot {
  formatVersion: 1;
  filters: {
    kinds: string[];
    edgeKinds: string[];
    languages: string[];
    filePrefix?: string;
  };
  stats: {
    totalNodes: number;
    totalEdges: number;
    exportedNodes: number;
    exportedEdges: number;
    exportedFiles: number;
    truncatedNodes: number;
  };
  nodes: GraphExportNode[];
  edges: GraphExportEdge[];
  files: GraphExportFile[];
}
```

Node objects include stable graph identity and source location:

```ts
interface GraphExportNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  signature?: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  isExported?: boolean;
}
```

Edge objects use Cartograph node ids:

```ts
interface GraphExportEdge {
  source: string;
  target: string;
  kind: string;
  line?: number;
  column?: number;
  confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
}
```

File objects are the files that contain at least one exported node:

```ts
interface GraphExportFile {
  path: string;
  language: string;
  nodeCount: number;
}
```

## Cytoscape

`--format cytoscape` returns:

```ts
interface CytoscapeGraphExport {
  formatVersion: 1;
  metadata: Pick<GraphExportSnapshot, 'filters' | 'stats'>;
  elements: {
    nodes: Array<{ data: Record<string, string | number> }>;
    edges: Array<{ data: Record<string, string | number> }>;
  };
}
```

Each Cytoscape node `data.id` is the Cartograph node id. Each edge `data.source`
and `data.target` references those ids.

## Limits

The default export cap is 1000 nodes. Increase it with `--limit`; the maximum
accepted value is 50000. When filtering matches more nodes than the cap,
`stats.truncatedNodes` reports how many matching nodes were left out.
