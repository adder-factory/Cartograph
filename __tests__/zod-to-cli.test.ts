/**
 * `zodSchemaToCliOptions` — the pure Zod-schema → commander-option
 * descriptor generator (structural campaign P3 infrastructure).
 *
 * P8 will wire these specs onto `program.command(...).option(...)`;
 * this suite locks the data shape so that wiring has a stable
 * contract.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodSchemaToCliOptions, zodSchemaToCommandSpec, toKebabCase } from '../src/mcp/tools/_zod-to-cli.js';

describe('toKebabCase', () => {
  it('converts camelCase to kebab-case', () => {
    expect(toKebabCase('maxDepth')).toBe('max-depth');
    expect(toKebabCase('projectPath')).toBe('project-path');
    expect(toKebabCase('query')).toBe('query');
  });

  it('handles acronym runs', () => {
    expect(toKebabCase('HTTPServer')).toBe('http-server');
    expect(toKebabCase('parseHTML')).toBe('parse-html');
  });

  it('handles digits at a boundary', () => {
    expect(toKebabCase('topN')).toBe('top-n');
    expect(toKebabCase('v2Schema')).toBe('v2-schema');
  });
});

describe('zodSchemaToCliOptions', () => {
  it('maps a string field to a value-taking string option', () => {
    const [spec] = zodSchemaToCliOptions(z.object({ query: z.string().describe('the query') }));
    expect(spec).toMatchObject({
      name: 'query',
      flag: '--query',
      description: 'the query',
      kind: 'string',
      required: true,
      isFlag: false,
    });
  });

  it('maps a boolean field to a value-less flag', () => {
    const [spec] = zodSchemaToCliOptions(z.object({ verbose: z.boolean().optional().describe('chatty') }));
    expect(spec).toMatchObject({
      name: 'verbose',
      flag: '--verbose',
      kind: 'boolean',
      isFlag: true,
      required: false,
    });
  });

  it('marks a default-true boolean as negatable (isNegated)', () => {
    const [spec] = zodSchemaToCliOptions(z.object({ compact: z.boolean().default(true).describe('compact rows') }));
    expect(spec).toMatchObject({ name: 'compact', kind: 'boolean', isFlag: true, isNegated: true });
  });

  it('does not mark a default-false / no-default boolean as negatable', () => {
    const [falseDefault] = zodSchemaToCliOptions(z.object({ verbose: z.boolean().default(false).describe('chatty') }));
    expect(falseDefault.isNegated).toBeUndefined();
    const [noDefault] = zodSchemaToCliOptions(z.object({ verbose: z.boolean().optional().describe('chatty') }));
    expect(noDefault.isNegated).toBeUndefined();
  });

  it('captures .int(), .min(), .max() on a number field', () => {
    const [spec] = zodSchemaToCliOptions(
      z.object({ maxDepth: z.number().int().min(1).max(10).default(4).describe('depth') }),
    );
    expect(spec).toMatchObject({
      name: 'maxDepth',
      flag: '--max-depth',
      kind: 'number',
      isInt: true,
      min: 1,
      max: 10,
      defaultValue: 4,
      required: false, // a `.default()` makes a field non-required
      isFlag: false,
    });
  });

  it('a plain number has no isInt / min / max', () => {
    const [spec] = zodSchemaToCliOptions(z.object({ ratio: z.number().describe('a ratio') }));
    expect(spec.kind).toBe('number');
    expect(spec.isInt).toBeUndefined();
    expect(spec.min).toBeUndefined();
    expect(spec.max).toBeUndefined();
  });

  it('maps an enum field to kind:enum with choices', () => {
    const [spec] = zodSchemaToCliOptions(z.object({ mode: z.enum(['fast', 'slow']).optional().describe('the mode') }));
    expect(spec).toMatchObject({
      name: 'mode',
      kind: 'enum',
      choices: ['fast', 'slow'],
      required: false,
      isFlag: false,
    });
  });

  it('marks a bare field required and an optional/default field not required', () => {
    const specs = zodSchemaToCliOptions(
      z.object({
        bare: z.string(),
        opt: z.string().optional(),
        def: z.string().default('x'),
      }),
    );
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    expect(byName.bare!.required).toBe(true);
    expect(byName.opt!.required).toBe(false);
    expect(byName.def!.required).toBe(false);
    expect(byName.def!.defaultValue).toBe('x');
  });

  it('reads .describe() off the outer wrapper (optional/default)', () => {
    const specs = zodSchemaToCliOptions(
      z.object({
        a: z.string().optional().describe('described on optional'),
        b: z.number().int().default(2).describe('described on default'),
      }),
    );
    expect(specs.find((s) => s.name === 'a')!.description).toBe('described on optional');
    expect(specs.find((s) => s.name === 'b')!.description).toBe('described on default');
  });

  it('falls back to an empty description when none is declared', () => {
    const [spec] = zodSchemaToCliOptions(z.object({ x: z.string() }));
    expect(spec.description).toBe('');
  });

  it('preserves field declaration order', () => {
    const specs = zodSchemaToCliOptions(z.object({ first: z.string(), second: z.string(), third: z.string() }));
    expect(specs.map((s) => s.name)).toEqual(['first', 'second', 'third']);
  });

  it('throws on a nested object leaf type', () => {
    expect(() => zodSchemaToCliOptions(z.object({ nested: z.object({ a: z.string() }) }))).toThrow(
      /not CLI-expressible/,
    );
  });
});

// ── P8 family-tool extension ───────────────────────────────────────

describe('zodSchemaToCliOptions — string-list (variadic) fields', () => {
  it('maps a z.array(z.string()) field to a variadic string-list option', () => {
    const [spec] = zodSchemaToCliOptions(
      z.object({ symbols: z.array(z.string()).max(20).optional().describe('symbol list') }),
    );
    expect(spec).toMatchObject({
      name: 'symbols',
      flag: '--symbols',
      kind: 'string-list',
      isVariadic: true,
      isFlag: false,
      required: false,
    });
  });

  it('carries choices for an array of enum elements', () => {
    const [spec] = zodSchemaToCliOptions(z.object({ fields: z.array(z.enum(['name', 'kind', 'id'])).optional() }));
    expect(spec.kind).toBe('string-list');
    expect(spec.choices).toEqual(['name', 'kind', 'id']);
  });

  it('throws on an array of objects (no flag form)', () => {
    expect(() => zodSchemaToCliOptions(z.object({ ranges: z.array(z.object({ a: z.string() })) }))).toThrow(
      /not CLI-expressible/,
    );
  });

  it('peels a z.preprocess (ZodPipe) to its array output — string-list', () => {
    // `cartograph_sql`'s `tables` field: a `z.preprocess` that accepts a
    // bare string OR an array, output-typed `z.array(z.string())`.
    const [spec] = zodSchemaToCliOptions(
      z.object({
        tables: z
          .preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.string()))
          .optional()
          .describe('table names'),
      }),
    );
    expect(spec).toMatchObject({
      name: 'tables',
      kind: 'string-list',
      isVariadic: true,
      isFlag: false,
      required: false,
    });
  });
});

describe('zodSchemaToCliOptions — string|number union fields', () => {
  it('maps a z.union([string, number]) field to a plain string option', () => {
    const [spec] = zodSchemaToCliOptions(
      z.object({ since: z.union([z.string(), z.number()]).optional().describe('threshold') }),
    );
    expect(spec).toMatchObject({
      name: 'since',
      kind: 'string',
      isFlag: false,
      required: false,
      description: 'threshold',
    });
  });

  it('throws on a union containing a non-scalar member', () => {
    expect(() => zodSchemaToCliOptions(z.object({ x: z.union([z.string(), z.object({ a: z.string() })]) }))).toThrow(
      /not CLI-expressible/,
    );
  });
});

describe('zodSchemaToCommandSpec — family discriminator detection', () => {
  it('detects an `action` enum as the discriminator', () => {
    const spec = zodSchemaToCommandSpec(
      z.object({
        action: z.enum(['init', 'sync', 'index']).describe('what to do'),
        force: z.boolean().optional(),
      }),
    );
    expect(spec.discriminator?.name).toBe('action');
    expect(spec.discriminator?.choices).toEqual(['init', 'sync', 'index']);
    // The discriminator is ALSO present in the full option list.
    expect(spec.options.map((o) => o.name)).toEqual(['action', 'force']);
  });

  it('detects `mode` / `by` / `direction` enums as discriminators', () => {
    for (const disc of ['mode', 'by', 'direction'] as const) {
      const spec = zodSchemaToCommandSpec(z.object({ [disc]: z.enum(['a', 'b']) }));
      expect(spec.discriminator?.name, `${disc} should be a discriminator`).toBe(disc);
    }
  });

  it('returns no discriminator for a flat tool with no axis enum', () => {
    const spec = zodSchemaToCommandSpec(z.object({ query: z.string(), limit: z.number().int().optional() }));
    expect(spec.discriminator).toBeUndefined();
    expect(spec.options).toHaveLength(2);
  });

  it('does not treat a non-axis enum (e.g. `detail`) as a discriminator', () => {
    const spec = zodSchemaToCommandSpec(z.object({ detail: z.enum(['preview', 'full']).default('preview') }));
    expect(spec.discriminator).toBeUndefined();
  });
});
