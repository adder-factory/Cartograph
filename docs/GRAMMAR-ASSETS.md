# Grammar Assets

Cartograph vendors tree-sitter WASM grammars under `src/extraction/wasm/`.
Every newly added grammar must record source, version, license, and the
checked-in asset hash here before it is merged.

## Upstream Tree-sitter Parser Tranche (2026-06-07)

These assets close the initial gap against Tree-sitter's upstream parser list
where the grammar is compatible with Cartograph's `web-tree-sitter` runtime.
All packages are MIT-licensed. Most assets were harvested from the npm package's
bundled `.wasm`; `verilog.wasm` was built from source by
`scripts/build-grammar-wasm.ts` because the package did not ship a bundled WASM.

| Asset | SHA-256 | Source package target | Package integrity | Repository |
|---|---|---|---|---|
| `src/extraction/wasm/css.wasm` | `8a23977fe271357cce6f254ef88c9bebf3854602d8046605aef6a45c02135c59` | `tree-sitter-css@0.25.0` | `sha512-FRc9R8ePrwJiUhZsuZ/wcFQ3K8Z+9yCgDrrUjuYswGWlN89UvcB9vslTUGZElQWGwhS8sUw3/r2n4lpb2sxT4Q==` | `https://github.com/tree-sitter/tree-sitter-css` |
| `src/extraction/wasm/embedded_template.wasm` | `d15bbf3cb90901d0372b5599761c7a1ada344a0f11573c173ace7042636a6174` | `tree-sitter-embedded-template@0.25.0` | `sha512-DLWFFWito68hgjMC3kDaqDpcHRGr+ZC2cz4pFR/XeWilq9C0dLawsxi+pK6qRM/ICZw6YNmf5w28y0tpcfbNsA==` | `https://github.com/tree-sitter/tree-sitter-embedded-template` |
| `src/extraction/wasm/haskell.wasm` | `37a6b07b1a838d02ffb4f4c2a06863637a8efe48432d60a275f50f1d08f1092c` | `tree-sitter-haskell@0.23.1` | `sha512-qG4CYhejveu9DLMLEGBz/n9/TTeGSFLC6wniwOgG6m8/v7Dng8qR0ob0EVG7+XH+9WiOxohpGA23EhceWuxY4w==` | `https://github.com/tree-sitter/tree-sitter-haskell` |
| `src/extraction/wasm/html.wasm` | `c48fcd82c7ea8bf943180088ba7f28c48b2bb5287874179168bf9d31e394cf85` | `tree-sitter-html@0.23.2` | `sha512-TN+l+7cCeLx9db/1RhRSqMAZO/266Oh2BHb8J8hMSSFLuzYvFTYP/UnD3S0mny5awzw05KzFNgu2vnwzN9wVJg==` | `https://github.com/tree-sitter/tree-sitter-html` |
| `src/extraction/wasm/jsdoc.wasm` | `5530e630fd42424b1c026ec4b2b260ff1b73b78b7040239ac33d4be22a9b2271` | `tree-sitter-jsdoc@0.25.0` | `sha512-ki7u9WA/AUZyk2ISULzFALL2iMax27O0Bz2O5WtyUkGAfJ97R0dgOSs0Bdf1zUpk6q5cq7bI2hBgJt29WH54Tw==` | `https://github.com/tree-sitter/tree-sitter-jsdoc` |
| `src/extraction/wasm/json.wasm` | `d2119fb98d5912719b13f9458574f8608d2d29dfbe45f6be1f860ea1fe2a2405` | `tree-sitter-json@0.24.8` | `sha512-Tc9ZZYwHyWZ3Tt1VEw7Pa2scu1YO7/d2BCBbKTx5hXwig3UfdQjsOPkPyLpDJOn/m1UBEWYAtSdGAwCSyagBqQ==` | `https://github.com/tree-sitter/tree-sitter-json` |
| `src/extraction/wasm/julia.wasm` | `e0f52c36eadf0299e46fccd6715c760d35eaa3f09721bec38633da551ac9e781` | `tree-sitter-julia@0.23.1` | `sha512-3vShY0GIu8ajR6hXzE0pyUk6kkfg4pGx3Bfzm6lGmR9aC3fe+LgoBMlaFJ7JY+t0fNFccc77J8HVP67ukuDMxQ==` | `https://github.com/tree-sitter/tree-sitter-julia` |
| `src/extraction/wasm/ocaml.wasm` | `761a78a804931cfac1fa0c6238989b4b0e86cc70db461b1315d743de923f8246` | `tree-sitter-ocaml@0.24.2` | `sha512-H0RAeCepIyXyTPCQra6yMd7Bn5ZBYkIaddzdLNwVZpM9mCe2e8av+3O6Ojl7Z8YHrV/kYsfHvI2y+Hh7qzcYQQ==` | `https://github.com/tree-sitter/tree-sitter-ocaml` |
| `src/extraction/wasm/ocaml_interface.wasm` | `c065e8da9052899592bd68c820ffda076e23394129de14c0bd2c46b189415ea9` | `tree-sitter-ocaml@0.24.2` | `sha512-H0RAeCepIyXyTPCQra6yMd7Bn5ZBYkIaddzdLNwVZpM9mCe2e8av+3O6Ojl7Z8YHrV/kYsfHvI2y+Hh7qzcYQQ==` | `https://github.com/tree-sitter/tree-sitter-ocaml` |
| `src/extraction/wasm/regex.wasm` | `e63c28e3a023614e14f2086b0d818e190239ebe5b2fcce7e64a9940091d83a79` | `tree-sitter-regex@0.25.0` | `sha512-Xf3KU+LOfCS6djfIzEHdVlq4ITinLNfVy7LkWqFr0R4ZG1SGV2u/HS4ct+TNwuLTPfU9EA/tQZnbJ/KLtgljgQ==` | `https://github.com/tree-sitter/tree-sitter-regex` |
| `src/extraction/wasm/verilog.wasm` | `67761c9e19dd2b809964194807017c32f4506405993c8ee53e1c40817bd5f662` | `tree-sitter-verilog@1.0.0` | `sha512-SSGUwA+mQ1Jxn/V2ROLj3+leO/68f+7MxWzoz5kOaJ3qzKAveSWjxOATGmiFMLy4DJ+/0pDXFnapwMDih2Cx6Q==` | `https://github.com/tree-sitter/tree-sitter-verilog` |

Regenerate check:

```sh
npm install --no-save --package-lock=false \
  tree-sitter-css@0.25.0 \
  tree-sitter-embedded-template@0.25.0 \
  tree-sitter-haskell@0.23.1 \
  tree-sitter-html@0.23.2 \
  tree-sitter-jsdoc@0.25.0 \
  tree-sitter-json@0.24.8 \
  tree-sitter-julia@0.23.1 \
  tree-sitter-ocaml@0.24.2 \
  tree-sitter-regex@0.25.0 \
  tree-sitter-verilog@1.0.0
for g in css embedded_template haskell html jsdoc json julia ocaml ocaml_interface regex verilog; do
  bun scripts/build-grammar-wasm.ts --only="$g"
done
bun test __tests__/tree-sitter-upstream-languages.test.ts __tests__/language-registry.test.ts
```

## HLSL

| Field | Value |
|---|---|
| Checked-in asset | `src/extraction/wasm/hlsl.wasm` |
| SHA-256 | `4b78f6b5121164ea5c02935864f314fb118ed286d0f4d91582fd91457cb6db2a` |
| Source package target | `tree-sitter-hlsl@0.2.0` |
| Package integrity | `sha512-nwPhvXJjBueq32kYSjrqc5NgqajCkllHeSlHp0VrGRwe+Dk5jSa2yoTE1+BHy/INVKOIigT4/gqW6DgWFoApeg==` |
| Repository | `https://github.com/tree-sitter-grammars/tree-sitter-hlsl` |
| License | MIT |

Regenerate check:

```sh
npm install --no-save --package-lock=false tree-sitter-hlsl@0.2.0
bun scripts/build-grammar-wasm.ts --only=hlsl --force-build
bun test __tests__/glsl-extraction.test.ts __tests__/language-registry.test.ts
```

## Apex / Salesforce

| Field | Value |
|---|---|
| Checked-in asset | `src/extraction/wasm/apex.wasm` |
| SHA-256 | `ffb52ba4bc33374b1d8d94da1a83484a81cb1183750192f48007ab9d41a03071` |
| Source package target | `tree-sitter-sfapex@3.0.0` (`apex/` subgrammar) |
| Package integrity | `sha512-AGwAjSr9WDM+1IgqpQfYEsi+FN4zjGaagPEU9RGrO7abNVc51X6gaAnBEdl7FMVAxEH1qWgHO8nO2Nbb8jOgAA==` |
| Repository | `https://github.com/aheber/tree-sitter-sfapex` |
| License | MIT |

Regenerate check:

```sh
npm install --no-save --package-lock=false tree-sitter-sfapex@3.0.0
bun scripts/build-grammar-wasm.ts --only=apex --force-build
bun test __tests__/salesforce.test.ts __tests__/language-registry.test.ts
```

Aura and Visualforce are custom markup extractors and do not add separate
tree-sitter grammar assets.

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
bun add -d tree-sitter-luau@1.2.0
bun scripts/build-grammar-wasm.ts --only=luau --force-build
bun test __tests__/luau-extraction.test.ts __tests__/language-registry.test.ts
```

If a regenerated asset changes this hash, inspect the Luau AST and extraction
fixtures before committing it. A tree-sitter load test only proves the grammar
loads; it does not prove Cartograph's extractor still sees the same node shapes.
