# Next Session: `go`

When the user says exactly `go`, read this file first and begin the first
unchecked task below.

## Current Goal

Refactor the Cartograph viewer browser app into maintainable smaller modules
without changing behavior.

The viewer has already been split from one large `index.html` into:

- `src/features/viewer/static/index.html` — markup only, currently about 387 lines.
- `src/features/viewer/static/viewer.css` — extracted stylesheet.
- `src/features/viewer/static/viewer.app` — extracted browser script, served as
  `text/javascript` but intentionally not named `.js` so Cartograph does not
  index the legacy browser script as source during the current transition.

## First Checklist

- [ ] Inventory `src/features/viewer/static/viewer.app` into logical sections and propose
      a small module boundary plan before editing. Keep the first pass
      mechanical: state/store, API/fetch helpers, graph rendering/layout,
      filters/grouping, detail/source panels, health dashboard, command palette,
      exports/editor helpers, and bootstrapping.
- [ ] Decide the module-loading strategy. Prefer native browser ES modules if it
      can preserve current behavior without a bundler. Keep generated/legacy
      static assets out of Cartograph indexing unless the browser code is also
      made clean enough for the release biomarker gate.
- [ ] Extract one low-risk module first, update `index.html`/server routes if
      needed, and run `bun test __tests__/viewer.test.ts`.
- [ ] Continue extracting modules in small batches, running the focused viewer
      test after each batch and the Playwright smoke test after meaningful UI
      movement.
- [ ] Finish with the full verification list below and refresh the tmux viewer
      session on port 8765.

## Workspace

- Project root: `/Users/adderclaudedev/projects/cartograph`
- Viewer URL used in the previous session: `http://localhost:8765/`
- If the viewer is not running, start it with:

```sh
bun src/bin/cartograph.ts viewer --no-open --port 8765 .
```

## Recent Viewer Work Completed

- Improved viewer graph polish: curved/non-straight edges, group collapse,
  kind/health filtering, clickable callers/callees/findings, pointer cursor
  affordances, reset-button overlap fix, selected-neighborhood highlighting,
  graph exports, and health dashboard polish.
- Added and expanded `scripts/viewer-smoke.ts` to exercise the major viewer
  functions with Playwright.
- Split static viewer assets:
  - `index.html` links `viewer.css` and `viewer.app`.
  - `src/features/viewer/server/` serves `/viewer.css` and `/viewer.app`.
  - `scripts/copy-assets.mjs` already copies every file under
    `src/features/viewer/static`, so no extra build rule was needed.
- Optimized viewer static asset serving:
  - CSS/app assets are preloaded once when the viewer server starts.
  - Asset responses include `ETag` and `Cache-Control: no-cache`.
  - Matching `If-None-Match` returns `304 Not Modified`.

## Verification Already Run

- `bun test __tests__/viewer.test.ts` passed.
- `npm run typecheck` passed.
- `PLAYWRIGHT_MODULE=/opt/homebrew/lib/node_modules/playwright/index.js npm run test:viewer-smoke` passed.
- `npm run build` passed.
- Final `npm run check:release` passed: `5076 pass / 0 fail / 18 skip`.
- Cartograph compare reported `0` introduced per-file biomarker findings after
  the final static-asset optimization.
- Live route probe confirmed `GET /viewer.app` returns an ETag and a matching
  `If-None-Match` returns `304 Not Modified`.

## Current Dirty Worktree Context

Do not reset or discard these changes. They are expected from the current
viewer/status/migration work unless the user explicitly asks otherwise.

Modified files observed:

- `NEXT_SESSION_GO.md`
- `__tests__/config-fingerprints.test.ts`
- `__tests__/no-llm-footer.test.ts`
- `__tests__/viewer.test.ts`
- `package.json`
- `src/mcp/server-instructions.ts`
- `src/mcp/tools/admin.ts`
- `src/mcp/tools/status.ts`
- `src/features/viewer/server/index.ts`
- `src/features/viewer/static/index.html`

Untracked files observed:

- `__tests__/migrations-072.test.ts`
- `__tests__/status-llm.test.ts`
- `scripts/viewer-smoke.ts`
- `src/mcp/tools/status-llm.ts`
- `src/features/viewer/static/viewer.app`
- `src/features/viewer/static/viewer.css`

## Final Verification For The Module Split

Run these before reporting done:

```sh
bun test __tests__/viewer.test.ts
PLAYWRIGHT_MODULE=/opt/homebrew/lib/node_modules/playwright/index.js npm run test:viewer-smoke
npm run build
npm run check:release
git diff --check
```

Also run Cartograph compare with findings delta and confirm no introduced
per-file biomarker findings in indexed files.
