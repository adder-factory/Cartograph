/**
 * Unit tests for `escapeRegExp` + `identifierBoundaryRegex` (F#80).
 *
 * These retire the "unescaped graph-derived identifier interpolated
 * into a regex" bug class. The headline failure mode: identifiers that
 * legally end in `$` — RxJS observables (`data$`), JVM synthetics
 * (`$delegate`) — broke every `new RegExp(`\\b${name}\\b`)` call site
 * (symbol→test attribution, rename call-site detection, the
 * accidental_quadratic guard) because a raw `$` is a regex end-anchor
 * and even an escaped trailing `\b` mis-fires after the non-word `$`.
 */
import { describe, it, expect } from 'vitest';
import { escapeRegExp, identifierBoundaryRegex } from '../src/utils.js';

describe('escapeRegExp', () => {
  it('escapes every regex metacharacter, including `*` (the gap older copies missed)', () => {
    // `a.b*c` must match only the literal string, not `axbXXXc`.
    const re = new RegExp(`^${escapeRegExp('a.b*c')}$`);
    expect(re.test('a.b*c')).toBe(true);
    expect(re.test('axbXXXc')).toBe(false);
  });

  it('treats `$` as a literal, not an end-anchor', () => {
    const re = new RegExp(escapeRegExp('data$'));
    expect(re.test('const data$ = of(1)')).toBe(true);
    // Without escaping, `data$` would only match `data` at end-of-line.
    expect(re.test('data')).toBe(false);
  });
});

describe('identifierBoundaryRegex', () => {
  it('matches a `$`-suffixed identifier as a standalone token (the cases plain \\b…\\b broke)', () => {
    const re = identifierBoundaryRegex('data$');
    expect(re.test('data$.subscribe()')).toBe(true); // trailing `.`
    expect(re.test('return data$;')).toBe(true); // trailing `;`
    expect(re.test('(data$)')).toBe(true); // wrapped
    expect(re.test('data$ = of(1)')).toBe(true); // trailing space
    expect(re.test('  data$')).toBe(true); // end of line
  });

  it('does not match when the identifier is a sub-token of a longer name', () => {
    const re = identifierBoundaryRegex('data$');
    expect(re.test('mydata$')).toBe(false); // leading identifier chars
    expect(re.test('data$x')).toBe(false); // trailing identifier char
    expect(re.test('data$2')).toBe(false); // trailing digit
    expect(re.test('userData$Field')).toBe(false);
  });

  it('bounds a plain identifier more strictly than \\b — `$foo` is not `foo`', () => {
    const re = identifierBoundaryRegex('foo');
    expect(re.test('a = foo()')).toBe(true);
    expect(re.test('foobar')).toBe(false);
    expect(re.test('barfoo')).toBe(false);
    // `$foo` is a distinct identifier; `\bfoo\b` would wrongly match it.
    expect(re.test('$foo')).toBe(false);
  });

  it('matches a leading-`$` identifier (JVM synthetic `$delegate`)', () => {
    const re = identifierBoundaryRegex('$delegate');
    expect(re.test('obj.$delegate')).toBe(true); // leading `.`, name starts with `$`
    expect(re.test('return $delegate;')).toBe(true);
    expect(re.test('x$delegate')).toBe(false); // identifier char before the `$`
    expect(re.test('$delegated')).toBe(false); // trailing identifier char
  });

  it('honours the global flag for find-all call-site scans (rename)', () => {
    const re = identifierBoundaryRegex('user$', 'g');
    const src = 'user$.pipe(); log(user$); const x = user$;';
    let count = 0;
    while (re.exec(src)) count++;
    expect(count).toBe(3);
  });

  it('escapes metacharacters in the identifier itself', () => {
    // A pathological name with a regex metachar must match literally,
    // never be interpreted as a pattern.
    const re = identifierBoundaryRegex('a.b');
    expect(re.test('x = a.b;')).toBe(true);
    expect(re.test('x = axb;')).toBe(false);
  });
});
