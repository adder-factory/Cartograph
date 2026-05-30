/**
 * Unit tests for `renderToolResponse` — the P5 response-envelope
 * chokepoint. Covers the four behaviours the per-handler tails kept
 * getting wrong:
 *
 *   1. body truncation at a line boundary;
 *   2. footers survive truncation of a wide body (the audit-4
 *      biomarkers bug — a footer placed before truncation was chopped);
 *   3. empty-result message + freshness hint;
 *   4. the no-footer / no-freshness pass is a plain passthrough.
 */
import { describe, it, expect } from 'vitest';
import { renderToolResponse } from '../src/mcp/tools/_response.js';
import { MAX_OUTPUT_LENGTH } from '../src/mcp/tools/shared.js';

const textOf = (r: ReturnType<typeof renderToolResponse>): string => {
  expect(r.content).toHaveLength(1);
  expect(r.content[0]!.type).toBe('text');
  return r.content[0]!.text;
};

describe('renderToolResponse — no-footer passthrough', () => {
  it('returns a short body verbatim with no footers/freshness', () => {
    const r = renderToolResponse({ body: 'hello world' });
    expect(textOf(r)).toBe('hello world');
    expect(r.isError).toBeUndefined();
  });

  it('drops blank / undefined footer entries', () => {
    const r = renderToolResponse({
      body: 'body',
      footers: ['', '   ', undefined, null],
    });
    expect(textOf(r)).toBe('body');
  });
});

describe('renderToolResponse — truncation', () => {
  it('does not truncate a body under the budget', () => {
    const body = 'x'.repeat(1000);
    expect(textOf(renderToolResponse({ body }))).toBe(body);
  });

  it('truncates an over-budget body and stays within MAX_OUTPUT_LENGTH', () => {
    // Many lines so the line-boundary cut has somewhere to land.
    const body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    expect(body.length).toBeGreaterThan(MAX_OUTPUT_LENGTH);
    const out = textOf(renderToolResponse({ body }));
    expect(out.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
    expect(out).toContain('(output truncated)');
  });
});

describe('renderToolResponse — footers survive truncation (audit-4 bug)', () => {
  it('keeps the footer when a wide body would otherwise push it off the budget', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join('\n');
    const footer = '> Result capped — pass a higher `limit` to see more.';
    const out = textOf(renderToolResponse({ body, footers: [footer] }));
    // The whole result fits the budget...
    expect(out.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
    // ...and the footer is still present at the very end.
    expect(out.endsWith(footer)).toBe(true);
    expect(out).toContain('(output truncated)');
  });

  it('joins multiple footers with blank lines, in order, after the body', () => {
    const out = textOf(
      renderToolResponse({
        body: 'BODY',
        footers: ['FOOTER-A', 'FOOTER-B'],
      }),
    );
    expect(out).toBe('BODY\n\nFOOTER-A\n\nFOOTER-B');
  });

  it('keeps multiple footers intact even when the body is truncated', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `r${i}`).join('\n');
    const out = textOf(
      renderToolResponse({
        body,
        footers: ['> cap hint', '> _call: `c_abc`_'],
      }),
    );
    expect(out.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
    expect(out).toContain('> cap hint');
    expect(out.endsWith('> _call: `c_abc`_')).toBe(true);
  });
});

describe('renderToolResponse — empty-result branch', () => {
  it('renders just the empty message when no freshness is given', () => {
    const out = textOf(
      renderToolResponse({
        body: 'IGNORED',
        empty: { message: 'No results found.' },
      }),
    );
    expect(out).toBe('No results found.');
  });

  it('appends a pre-rendered freshness hint to the empty message', () => {
    const out = textOf(
      renderToolResponse({
        body: 'IGNORED',
        empty: {
          message: 'No results found.',
          freshness: { text: '\n\n> _Index in sync._' },
        },
      }),
    );
    expect(out).toBe('No results found.\n\n> _Index in sync._');
  });

  it('ignores body / footers when empty is set', () => {
    const out = textOf(
      renderToolResponse({
        body: 'BODY',
        footers: ['FOOTER'],
        empty: { message: 'nothing here' },
      }),
    );
    expect(out).toBe('nothing here');
  });
});

describe('renderToolResponse — pre-rendered freshness on a non-empty result', () => {
  it('appends a freshness note after the footers', () => {
    const out = textOf(
      renderToolResponse({
        body: 'BODY',
        footers: ['FOOTER'],
        freshness: { text: '\n\n> ⚠ Stale results.' },
      }),
    );
    expect(out).toBe('BODY\n\nFOOTER\n\n> ⚠ Stale results.');
  });

  it('keeps the freshness note within budget when the body is wide', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `r${i}`).join('\n');
    const note = '\n\n> ⚠ Stale results — file modified since last index: src/x.ts';
    const out = textOf(
      renderToolResponse({
        body,
        footers: ['> cap hint'],
        freshness: { text: note },
      }),
    );
    expect(out.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
    expect(out.endsWith(note)).toBe(true);
    expect(out).toContain('> cap hint');
  });
});

describe('renderToolResponse — maxLength override', () => {
  it('honours a higher per-tool budget', () => {
    const body = 'x'.repeat(20000);
    const out = textOf(renderToolResponse({ body, maxLength: 30000 }));
    expect(out).toBe(body);
  });

  it('honours a lower per-tool budget', () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const out = textOf(renderToolResponse({ body, maxLength: 200 }));
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
