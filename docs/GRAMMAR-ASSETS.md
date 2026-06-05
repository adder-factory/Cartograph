# Grammar Assets

Cartograph vendors tree-sitter WASM grammars under `src/extraction/wasm/`.
Every newly added grammar must record source, version, license, and the
checked-in asset hash here before it is merged.

## Luau

| Field | Value |
|---|---|
| Checked-in asset | `src/extraction/wasm/luau.wasm` |
| SHA-256 | `f1647052518f2bdfae8e8c0b033ffdeca1193d69d11c78ba20f84c8374fd0fe3` |
| Source package target | `tree-sitter-luau@1.2.0` |
| Package integrity | `sha512-2LBeROsknOCLzryCFyqTgZ6AXiEl4U0/f32ILn7BQWCPABVtNwNh9U+MDnSUrGJRNvFicrfh+KcVRyKtG0ZEuQ==` |
| Repository | `https://github.com/tree-sitter-grammars/tree-sitter-luau` |
| License | MIT |

Regenerate check:

```sh
npm install --no-save tree-sitter-luau@1.2.0
bun scripts/build-grammar-wasm.ts --only=luau --force-build
bun test __tests__/luau-extraction.test.ts __tests__/language-registry.test.ts
```

If a regenerated asset changes this hash, inspect the Luau AST and extraction
fixtures before committing it. A tree-sitter load test only proves the grammar
loads; it does not prove Cartograph's extractor still sees the same node shapes.
