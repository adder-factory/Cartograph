# Extending extractors + framework resolvers

> Extracted from CLAUDE.md (2026-05-29) to keep the always-loaded project memory lean. These are the accumulated per-arc "what to know when extending" notes — read before adding a language, a framework resolver, or a cross-language bridge. CLAUDE.md keeps a one-paragraph pointer to this file.

### Polyglot / monorepo coverage (G16 arc — 2026-05-22)

The 5 patterns above retire bug CLASSES. The G16 arc closed COVERAGE GAPS in those patterns, surfaced by hunting against an unfamiliar repo (Bun workspaces monorepo with TS+TSX+Rust). What to know when extending the same tools:

- **`cartograph_deps` walks workspaces.** `src/deps/unused.ts` builds a `WorkspaceManifest[]` from `workspaces:` (array OR yarn-classic `{packages: [...]}` object) via `Bun.Glob.scanSync`. `USED_SIGNAL_RULES` + `UNDECLARED_SUPPRESSION_RULES` iterate this list, so any new used-signal / undeclared-suppression rule gets workspace coverage for free. `!apps/excluded` negation entries are intentionally skipped (Bun.Glob can't express them); pnpm-workspace.yaml is a separate file format and remains a follow-up.
- **`bun-serve` is a registered framework resolver.** `src/resolution/frameworks/bun-serve.ts` emits `kind:'route'` nodes for `Bun.serve({routes: {...}})` calls. Two shapes: `'/path': handler` (one node, no method prefix — Bun.serve dispatches method in handler) and `'/path': { GET, POST }` (one node per method, `GET /path` matching Express convention). New Bun-native HTTP frameworks should follow the same regex-based shape with `findMatchingClose` + `depthAtIndex` for nested-brace safety. Bun.serve detection signals: `@types/bun` / `bun` package.json dep, `bunfig.toml` presence, source-level `Bun.serve(` token.
- **JSX usage is a `references` use-edge.** `ts-extract-bodies.ts > captureBodyJsxReferences` emits a `references` unresolved-ref for every PascalCase JSX identifier (`<RailGroup />`, `<foo.Bar />`, `<svg:rect />`). HTML primitives (lowercase first letter) skipped. Reads into the existing `ORPHAN_LIVENESS_EDGE_KINDS` set used by `findOrphanedSymbols` + the cross-file `unused_export` rule, so React components used only via JSX in their own file no longer false-flag as dead. Any new JSX-like syntax (Solid, Preact, Astro JSX dialects) inherits this for free via the same node types.

### Polyglot / Go coverage (2026-05-23d arc — ollama bug-hunt)

Companion arc to G16; surfaced 15+ real bugs by hunting against ollama (807 .go + 209 .cpp + small embedded TS UI). What to know when extending the same tools:

- **Go `is_exported` follows the PascalCase convention.** `src/extraction/languages/go.ts` `isExported` callback returns `/^[A-Z]/.test(name)`. Methods (`methodsAreTopLevel: true`) get evaluated per-method via `tsEmitMethodNode`'s methodsTopLevel branch — JS/TS classic-OO unchanged (the enclosing class still carries the export). Name-only check; strict-spec receiver-type check is a deferred follow-up. Downstream cascade: `findUnusedExports` (`is_exported = 1` filter) + entry-points `public_exports` bucket both light up for Go.
- **Go struct fields + interface methods are first-class nodes.** `tsExtractField`'s Go branch handles `field_declaration > field_identifier` (multi-name + tag-stripping). Interface `method_elem` walked by `extractInterfaceTypeAlias` after pushing the interface onto `nodeStack` so `createNode`'s auto-`contains` edge fires interface→method (NOT file→method — that was a real reviewer-caught bug in the first draft). Qualified embedded fields (`model.Base` / `*tokenizer.Tokenizer`) handled via the new `qualified_type` branch in `extractGoEmbeddedField`; bare `type_identifier` already covered the `*Options` collapsed-pointer case.
- **`classifyImport` carries three optional per-language hints.** `ClassifyImportOpts.goModuleAlias` (strip + reanchor `github.com/<mod>/...` to local dirs), `cIncludeStyle: 'quoted' | 'angled'` (probe relative to importing file for C `#include "x"`), `tsPathAliases` (resolve TS `@/*` aliases via the nearest tsconfig walked from the importing dir). New per-language behaviors should follow the same caller-pure-classifier pattern: helper reads disk + caches; classifier stays pure.
- **`goResolver.resolve` proximity tiebreak.** All four framework patterns (Handler / Service / Middleware / Model) now pass `ref.filePath` into `resolveByNameAndKind`, which sorts surviving candidates by same-file → shared-dir-segments before picking `pool[0]`. Without this, alphabetical name-index order picked an arbitrary winner — 13 of 14 ollama Options-embed edges resolved to the wrong target package.
- **cgo Go→C call edges.** `tsResolveMemberCallName` strips the `C.` pseudo-receiver for Go so `C.foo(...)` resolves to the bare `foo` C function. Cgo identifier `C` is the only legal way to use that name in Go (the pseudo-import); a JS/TS one-letter class wouldn't get the same strip.
- **Go `implements` edges via `go-implements` hook.** Project-wide post-pass in Group B. Method-name superset match struct ⊇ interface; empty interfaces skipped. New `last_mined_go_implements_algo_version` metadata key; mismatch triggers a full re-mine on next sync.
- **Cobra is a registered CLI framework.** `src/resolution/frameworks/go.ts` `cobraCommandPattern` extracts `&cobra.Command{Use: "verb ..."}` literals as `cmd <verb>` routes (matching the JS commander/yargs/cac convention). `isCliCommandRoute()` folds both into the existing cli bucket without further wiring. Comment-strip pass now applies to ALL five Go framework patterns (Gin / Echo / Chi / http / cobra) — extending one means routing it through `stripCommentsForRegex(content, 'go')`.
- **`MCP ProjectCache` survives CLI re-init.** `_project-cache.ts` fingerprints `.cartograph/cartograph.db` by inode + size at open; mismatch on lookup evicts + reopens. CLI `admin init` (or any rm-then-recreate cycle) under an active MCP no longer leaves the cached handle pointing at the deleted inode.

Provenance: `[[project_session_handoff_2026_05_23d_ollama_bug_hunt]]`.

Provenance + reviewer findings: `docs/STRUCTURAL-CAMPAIGN-BACKLOG.md` section D.

### Cross-language bridging + framework-resolver hooks (B12 arc — 2026-05-29)

Landed with B12 sub-channel 1 (Swift↔ObjC `@objc` bridge, commit `4009f5f9`).
Reusable infrastructure for the remaining B12 channels (RN / Expo / Fabric)
and any future cross-language or selector-shape resolver:

- **Swift attributes are captured into `Node.decorators`.** Swift `@objc` /
  `@objcMembers` / `@nonobjc` / `@IBAction` parse as
  `modifiers > attribute > user_type > type_identifier`; `findDecoratorTarget`
  (`ts-extract-calls.ts`) descends the `user_type` to its `type_identifier`
  (mirrors the Kotlin `constructor_invocation` branch). So
  `@objc func play()` → `Node.decorators = ['objc']`. **Read `@objc`
  exposure STRUCTURALLY off `Node.decorators`, never by re-parsing a source
  window** — that's the audit fix `isNodeObjcExposed` in `swift-objc.ts`
  encodes (`@nonobjc` opts out; own `@objc` opts in; AND class-level
  `@objcMembers` blanket-exposes every member via `buildObjcMembersExposedSet`,
  which maps members to their class by line-range since `ResolutionContext`
  has no edge/container query). The `user_type` branch also improved
  bare-Kotlin-annotation (`@Foo`) capture.
- **`FrameworkResolver.claimsReference(name): boolean`** (optional) — a
  pre-filter bypass. `resolve()` only runs for refs that pass the known-node
  gate (`resolverHasAnyPossibleMatch`), but some framework refs are named
  after NOTHING in the graph (a bridged ObjC selector resolves to a
  differently-named Swift method). Returning true opts a name past the gate
  (wired via `resolverAnyFrameworkClaims` in `resolveOne`). **Consulted ONLY
  for DETECTED frameworks**, so an opt-in is scoped to projects using the
  framework. Keep it NARROW — swift-objc claims only names the bridge
  *transforms* (`fooWithBar`→`foo`), not every name.
- **`FrameworkResolver.clearCache(context): void`** (optional) — per-context
  cache invalidation. A resolver memoizing graph-derived state keyed by the
  `ResolutionContext` (e.g. swift-objc's reverse-bridge `WeakMap` of ObjC
  method nodes) implements this; `ReferenceResolver.clearCaches()` calls it at
  every resolution-pass boundary. **The context is long-lived and REUSED
  across syncs**, so a context-keyed cache that isn't cleared here goes stale
  when a sync adds/removes nodes (it self-invalidates only on full `indexAll`,
  which makes a fresh context). Required for any per-context resolver cache.
- **Resolver lifecycle: `detect()` that reads the INDEX must rely on the
  `warmCaches()` re-detect.** `createResolver()` → `initialize()` →
  `detectFrameworks()` runs at resolver CREATION, *before* extraction — so a
  `detect()` reading `context.getAllFiles()` (swift-objc / swiftUI / uikit)
  saw an empty index and silently never fired (disk-based detects like
  drupal/composer.json were unaffected, which masked the bug for a long time).
  `warmCaches()` now re-runs `detectFrameworks()` post-extraction (once per
  pass; strictly more detections than the empty-index run, so no regression).
  New resolvers whose `detect()` queries the graph depend on this.
- **ObjC CALL refs carry the FULL selector, matching method DEFINITIONS
  (since F#82a).** `[obj fooWithBar:42]` → unresolved-ref `obj.fooWithBar:`
  (receiver prefix + every keyword, colons kept), and the method-definition
  NODE is named with the same full selector `fooWithBar:` (and
  `downloadURL:completion:`). So a same-language ObjC call resolves through the
  plain name-matcher, and a cross-language bridge fires only when the target is
  a colon-free Swift node — `swiftBaseNamesForObjcSelector` strips the trailing
  colons internally and recovers `foo` from `fooWithBar:`. **Consequence for a
  resolver that runs on colon-bearing ObjC refs: BAIL when a real ObjC node
  owns the selector** (framework resolvers run before the name-matcher in
  `resolveOne`, so a bridge that doesn't bail will hijack an ObjC→ObjC call to a
  same-base-named Swift method — see `resolveObjcCallToSwift`). Pre-F#82a these
  refs were colon-STRIPPED (`obj.fooWithBar`); resolvers written against that
  older shape must be revisited.

Provenance: commit `4009f5f9`; BACKLOG.md "B12 sub-channel 1".

### React Native JS↔native bridge — synthesize when the grammar can't parse (B12 sub-channel 2 — 2026-05-29)

`reactNativeBridgeResolver` (`src/resolution/frameworks/react-native.ts`;
pure parsing in `react-native-bridge.ts`) bridges JS callers to native impls.
Patterns worth reusing for the remaining channels (Expo / Fabric / event
synthesizers) and any ObjC-macro-based or codegen-spec resolver:

- **ObjC RN bridge MACROS don't parse — SYNTHESIZE the target nodes.**
  `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` / `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD`
  degrade to `macro_type_specifier` + cascading ERROR nodes in the vendored
  `objc.wasm` grammar, so the ObjC extractor emits ZERO method nodes for them
  (and the ERROR cascade swallows adjacent non-macro methods in the same
  `@implementation` — F#82). A `resolve()`-only resolver has nothing to point
  at. The fix: the resolver's **`extractNodes` hook regex-parses the macros and
  MINTS a `method` node per export** (named by its JS-visible name — first
  selector keyword, or the `RCT_REMAP` override — tagged
  `decorators:['RCTExport']` so `buildRNMaps` finds them; emitter built-ins
  skipped at synthesis). `languages: ['objc']` gates `extractNodes` to `.m`/`.mm`
  (both are the single `objc` Language); `resolve()` is NOT gated by `languages`
  (the orchestrator calls every detected resolver's `resolve()`), so the same
  resolver self-filters `resolve()` to JS refs. Mirrors the Drupal virtual-node
  precedent.
- **Read JVM `@ReactMethod` structurally — no synthesis.** Java AND Kotlin
  `@ReactMethod` land in `Node.decorators=['ReactMethod']` (the same
  `findDecoratorTarget` machinery as Swift `@objc`). Filter
  `getNodesByKind('method')` on the decorator; cleaner than upstream's regex,
  and the `getName()` module-name string is unreachable from the graph anyway
  (only `body_hash`), so resolve keys on the JS method name, not the module.
- **`claimsReference` can admit a whole CLASS of names via a `detect()`-built
  set.** The known-node pre-filter (`resolverHasAnyPossibleMatch`) drops a bare
  JS ref (`getTotalLength`) when its only native impl is a regular colon-named
  Codegen ObjC node (`getTotalLength:`) — it never reaches `resolve()`.
  `claimsReference(name)` is **context-free by interface**, so it can't query
  the graph; instead `detect()` (which runs in `warmCaches`, before any ref
  resolves, AND has the context) populates a **module-level add-only `Set`** of
  TurboModule spec method names, and `claimsReference` membership-checks it.
  Over-claiming is safe — it only costs an extra `resolve()` that returns null
  (resolve is context-correct, keyed off the per-context cache that `clearCache`
  DOES invalidate). **Unit-testing `resolve()` directly BYPASSES this gate** —
  add an end-to-end test through `Cartograph.init` to exercise the real
  pre-filter (a reviewer caught this gap precisely because the unit test hid it).
- **Codegen spec files: brace-balanced body extraction, not a `{…}` regex.**
  A TurboModule `Spec` interface is the JS-visible ground truth. A non-greedy
  `\{([\s\S]*?)\}` truncates at an inline object type
  (`getConstants(): {x: string};` — real in RN's `NativeDeviceInfo`), dropping
  later methods; a greedy last-`}` over-captures trailing code. Walk braces from
  the opening `{` to the depth-0 close (`extractSpecInterfaceBody`). Normalize
  CRLF→LF first. Gate the `.ts` scan on the codegen `Native*`/`*Spec` filename
  convention (non-lossy — codegen requires that naming) to bound the per-pass
  read.

Provenance: BACKLOG.md "B12 sub-channel 2"; tests in
`__tests__/react-native-bridge.test.ts`.

### Expo Modules — synthesize the DSL, and resolve() is mandatory here (B12 sub-channel 3 — 2026-05-29)

`expoModulesResolver` (`src/resolution/frameworks/expo-modules.ts`; pure DSL
parsing in `expo-modules-bridge.ts`) bridges JS `requireNativeModule('X').y()`
to the Swift/Kotlin Expo `Module { Name("X"); Function("y") { … } }` DSL.

- **The DSL's JS names are string ARGS — synthesize, don't read the graph.**
  `Function("y")` / `AsyncFunction` / `Property` / `Constants("y")` and the
  module's `Name("X")` are string literals passed to builder calls. The
  universal extractor records only a call's CALLEE name (`Function`, `Name`),
  never its string args — so `"y"`/`"X"` are unreachable from any node, ref,
  edge, decorator, or signature (verified empirically for BOTH Swift and
  Kotlin; the lambda BODIES are walked, but that doesn't recover the member
  name). So `extractNodes` regexes the source and MINTS a `method` node per
  member, named by the JS-visible name, tagged `decorators:['ExpoExport']`.
  Same forced strategy as ch.2's ObjC-macro synthesizer.
- **THE LOAD-BEARING FORK FINDING: the member-call name-matcher is
  receiver-TYPE-driven.** Upstream's Expo resolver sets `resolve()` to null and
  relies on the standard name-matcher to close a JS `Foo.takePictureAsync()`
  call to the synthesized node by method name. **That does NOT work in this
  fork** — the end-to-end tests proved it: when the receiver (`Foo =
  requireNativeModule('X')`) is an untyped binding, the matcher can't type the
  receiver and never resolves the member by name alone (it DOES resolve
  same-class `self.foo()` calls — the gap is specifically untyped-receiver
  cross-language member calls). **So every JS↔native channel in this fork must
  carry a `resolve()` that bridges by name; a synthesizer alone is not enough.**
  Expo's `resolve()` looks up the `ExpoExport`-tagged node by
  `stripReceiverPrefix(ref.referenceName)` (iOS/swift-preferred), confidence
  0.6 / `resolvedBy:'framework'`. No `claimsReference` (the synthesized JS name
  is already in `knownNames`, so the pre-filter passes); no per-context cache /
  `clearCache` (a direct `getNodesByName` + decorator filter, no memo).
- **Marker decorator scopes the bridge.** `resolve()` keys on method name, so
  the `ExpoExport` tag is what stops it from bridging to an unrelated same-named
  ordinary method. The trade-off it does NOT solve: it ignores the JS receiver's
  module binding, so a common member name can over-bridge an unrelated
  `obj.name()` call (0.6/INFERRED, Expo-projects only) — matches upstream's
  name-only precision; tracking `requireNativeModule('X')` bindings is the
  future precision lever.
- **Stateful `g`-flag regex.** The member-scan regex is built fresh per parse
  (`new RegExp(src, 'g')`) — a shared module-level `/…/g` leaks `lastIndex`
  across files and silently skips matches on the 2nd+ file.

Provenance: BACKLOG.md "B12 sub-channel 3"; tests in
`__tests__/expo-modules.test.ts`.

### Fabric/Paper view components — JSX resolves FREE by name; node→node bridges are index-hooks (B12 sub-channel 4 — 2026-05-29)

`fabricViewResolver` (`src/resolution/frameworks/fabric.ts`; parsing in
`fabric-bridge.ts`) synthesizes `component` + `property` nodes for RN view
components; the `fabric-native-impl` index-hook
(`src/index-hooks/fabric-native-impl.ts`) bridges them to native classes.

- **Component-name resolution is NOT the receiver-type-driven member-call
  matcher — so a synthesized `component` node resolves JSX for free.** This is
  the key contrast with ch.3: a JSX `<MyView>` ref is emitted (PascalCase, by
  `captureBodyJsxReferences`) and `react.ts` `resolveComponent` resolves it BY
  NAME against kind ∈ {component, function, class}. So a synthesized
  `kind:'component'` node named `MyView` (from `codegenNativeComponent('MyView')`
  or a `*ViewManager` class) closes the JS→component edge with **no `resolve()`
  and no marker decorator** on the resolver — which is why fabric's `resolve()`
  is a no-op. (The string args + view-prop macros are still grammar-invisible,
  so the nodes are still SYNTHESIZED from source — same as ch.2/ch.3.)
- **A node→node link by convention is an INDEX-HOOK, not a `resolve()`.** The
  component→native-class bridge has no JS ref to resolve — both endpoints are
  already nodes; the edge is established post-extraction by name+suffix
  convention (`Foo` → `Foo`/`FooView`/`FooViewManager`/`FooComponentView`/
  `FooManager`). That's an index-hook's job (cf. `go-implements`,
  `drupal-service-tags`): walk the nodes, emit `references` edges with
  `metadata.synthesizedBy`, with an `*_ALGO_VERSION` self-heal + a clean-slate
  `DELETE … json_extract(metadata,'$.synthesizedBy')=?` before re-inserting.
  Register in `src/index-hooks/registry.ts` (Group B, before the Group C
  centrality/biomarkers that count the edges) AND add the hook name to
  `__tests__/hook-groups-invariance.test.ts`'s `EXPECTED_GROUP_B`, AND its
  metadata key to `MetadataKey` in `src/db/queries-metadata.ts`.
- **Scan PAST helper classes when finding the framework class.** A
  `source.match(/class …/)` grabs only the FIRST class; a `data class` / helper
  declared before the `*ViewManager` makes it silently miss the manager. Scan
  all matches for the first whose name fits the convention
  (`findManagerClass`). (Same trap applies to any per-file "find THE class".)
- **Share brace-balanced interface parsing.** `extractInterfaceBody(src, name)`
  in `src/resolution/_interface-body.ts` (escapeRegExp-guarded) is the one
  brace-balanced TS-interface-body extractor — reused by the RN `Spec` and
  Fabric `NativeProps` parsers; don't re-implement the `\{…\}` scan (a regex
  truncates at inline object types).

Provenance: BACKLOG.md "B12 sub-channel 4"; tests in
`__tests__/fabric-view.test.ts`.

### RN event channel — re-read source in a hook; and the algo-hash `[]` trap (B12 sub-channel 5 — 2026-05-29)

`rn-event-channel` (`src/index-hooks/rn-event-channel.ts`; parsing in
`rn-event-bridge.ts`) links a native event dispatch (`sendEventWithName:@"X"`
/ `sendEvent(withName:"X")` / `.emit("X",…)`) to every JS subscriber
(`.addListener("X", handler)`) sharing the literal event name.

- **An index-hook CAN re-read source** even though `IndexHookContext` lacks
  `readFile`/`getAllFiles`: use `getAllFiles(ctx.queries)` (→ `FileRecord[]`
  with `.path`/`.language`) + `readFileSafe(path.join(ctx.projectRoot,
  file.path))` + `stripCommentsForRegex(raw, file.language)` — the
  `value-ref-edges` idiom. Needed whenever the signal is a string literal the
  extractor doesn't node-ify (event names, like the other channels' string
  args). Map a match offset → enclosing graph node with
  `ctx.queries.getNodesByFile(path)` + a tightest-encloser scan over
  function/method/component nodes.
- **Use `makeLineIndex(content)` for offset→line, never
  `content.slice(0,idx).split('\n').length`** — the latter is the F#72
  Schlemiel-quadratic bug class (re-scans the prefix per match). It bit this
  hook in review.
- **THE ALGO-HASH `[]` TRAP (F#85).** `computeAlgoHash(import.meta.url, [])`
  hashes NOTHING — it returns the empty-input SHA constant for every caller, so
  the hook's `*_ALGO_VERSION` never changes on a logic edit and its self-heal
  silently no-ops (re-mines only on first run + changed-file syncs; a logic
  change then needs a manual `admin index`). **Pass the hook's own source
  basename(s):** `computeAlgoHash(import.meta.url, ['./my-hook'])`, plus any
  sibling module whose logic the hook depends on (rn-event-channel adds
  `'../resolution/rn-event-bridge'`). `__tests__/hook-algo-versions.test.ts`
  guards every hook against regressing to `[]`. (All 10 `src/index-hooks/*`
  hooks shipped with the `[]` no-op until this fix; the curated string-miners
  under `src/<miner>/index.ts` always passed `['./index']` correctly.)
- **String-name ↔ string-name synthesizers are index-hooks** (both endpoints
  are existing nodes; the match key is a parsed string), `kind:'calls'` +
  `confidence:'INFERRED'` + `metadata.synthesizedBy`, with a fan-out cap
  (`EVENT_FANOUT_CAP=6`) to skip too-generic names.

Provenance: BACKLOG.md "B12 sub-channel 5" + "F#85"; tests in
`__tests__/rn-event-channel.test.ts` + `__tests__/hook-algo-versions.test.ts`.
