/**
 * cartograph_explore comment-block collapse.
 *
 * `collapseCommentBlocks` folds runs of >= MIN_COLLAPSIBLE_COMMENT_RUN (4)
 * consecutive pure-comment lines in a rendered source slice into a single
 * `// ... N lines of comments ...` marker, so license banners and multi-line
 * doc blocks don't crowd real code out of the EXPLORE_MAX_OUTPUT budget.
 *
 * Each test pins a distinct regression, not the obvious happy path:
 *  - a >=4-line block collapses BUT every code line around it survives
 *    (the bug would be eating code as if it were comment);
 *  - a <4-line comment run stays verbatim (a `// HACK` / one-line doc
 *    header must not vanish — and this is why a lone `// ... (gap) ...`
 *    marker, a run of 1, can never collapse);
 *  - a code line carrying a trailing inline comment is NEVER collapsed;
 *  - the collapse is multi-language via stripCommentsForRegex (Python `#`
 *    blocks, not just C-family `//`);
 *  - an unknown / empty language is a no-op (no comment syntax to detect).
 */
import { describe, it, expect } from 'vitest';
import { collapseCommentBlocks } from '../src/mcp/tools/explore.js';

describe('collapseCommentBlocks', () => {
  it('collapses a >=4-line doc block while preserving all surrounding code', () => {
    const src = [
      'function alpha() {', //          code
      '  return 1;', //                 code
      '}', //                           code
      '/**', //                         comment run start (5 lines)
      ' * Beta does a thing.', //       comment
      ' * @param x the input', //       comment
      ' * @returns the output', //      comment
      ' */', //                         comment run end
      'function beta(x) {', //          code
      '  return x + 1;', //             code
      '}', //                           code
    ].join('\n');

    const out = collapseCommentBlocks(src, 'typescript');

    // The 5-line doc block became one marker...
    expect(out).toContain('// ... 5 lines of comments ...');
    expect(out).not.toContain('@param x the input');
    expect(out).not.toContain('Beta does a thing');
    // ...but every code line is byte-for-byte intact.
    for (const codeLine of ['function alpha() {', '  return 1;', 'function beta(x) {', '  return x + 1;']) {
      expect(out).toContain(codeLine);
    }
  });

  it('keeps a short (<4-line) comment run verbatim — no marker', () => {
    const src = [
      'function f() {',
      '  // HACK: special-case the empty path',
      '  // see issue 42',
      '  return 0;',
      '}',
    ].join('\n');
    const out = collapseCommentBlocks(src, 'typescript');
    expect(out).not.toContain('lines of comments ...'); // nothing collapsed
    expect(out).toContain('// HACK: special-case the empty path');
    expect(out).toContain('// see issue 42');
    expect(out).toBe(src); // a 2-line run is wholly untouched
  });

  it('never collapses a code line that carries a trailing inline comment', () => {
    // Four consecutive lines that all END in `//` comments but each also
    // has CODE — none are "pure comment", so the run must not collapse.
    const src = ['const a = 1; // one', 'const b = 2; // two', 'const c = 3; // three', 'const d = 4; // four'].join(
      '\n',
    );
    const out = collapseCommentBlocks(src, 'typescript');
    expect(out).toBe(src);
    expect(out).not.toContain('lines of comments ...');
  });

  it('collapses Python `#` doc blocks (multi-language via stripCommentsForRegex)', () => {
    const src = [
      'def handler(req):',
      '    # Step 1: validate the request',
      '    # Step 2: look up the route',
      '    # Step 3: invoke the view',
      '    # Step 4: build the response',
      '    return dispatch(req)',
    ].join('\n');
    const out = collapseCommentBlocks(src, 'python');
    expect(out).toContain('// ... 4 lines of comments ...');
    expect(out).toContain('def handler(req):');
    expect(out).toContain('    return dispatch(req)');
    expect(out).not.toContain('Step 2: look up the route');
  });

  it('is a no-op for an unknown / empty language', () => {
    const src = ['// a', '// b', '// c', '// d', '// e', 'code()'].join('\n');
    expect(collapseCommentBlocks(src, '')).toBe(src);
    expect(collapseCommentBlocks(src, 'cobol-83')).toBe(src);
  });

  it('documents the string-unawareness limitation: comment-shaped STRING content collapses', () => {
    // KNOWN, ACCEPTED limitation (see collapseCommentBlocks JSDoc): the
    // comment detector is regex-based (stripCommentsForRegex), not a lexer, so
    // a multi-line string/template literal whose interior lines are each a
    // standalone block comment is misread as a comment run and collapsed. The
    // on-disk file is untouched — this only changes explore's rendering — and
    // it needs 4+ such lines to trigger. This test pins the behaviour so a
    // future change that fixes it (string-aware detection) or worsens it is
    // visible rather than silent.
    const blk = (s: string) => `/* ${s} */`;
    const src = ['const tpl = `', blk('alpha'), blk('beta'), blk('gamma'), blk('delta'), '`;', 'doThing();'].join('\n');
    const out = collapseCommentBlocks(src, 'typescript');
    expect(out).toContain('// ... 4 lines of comments ...'); // the 4 string lines collapse
    expect(out).toContain('const tpl = `'); // real code on the boundary survives
    expect(out).toContain('doThing();');
  });
});
