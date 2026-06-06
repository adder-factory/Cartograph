export interface CompareToRefCapture {
  text: string;
  exitCode: number;
  contentDriftedFiles: number | null;
}

export interface CompareToRefRender {
  stream: 'stdout' | 'stderr';
  text: string;
  exitCode: number;
}

export function isEmptyCompareToRefText(text: string): boolean {
  // The MCP `compare-to-ref` empty marker renders the ref wrapped in
  // backticks, e.g. `No files differ from `HEAD`.`. Match any ref token.
  return /No files differ from `[^`]+`\.\s*$/m.test(text);
}

export function changedSinceDriftHint(contentDriftedFiles: number): string {
  return (
    `\n\n_Note: \`cartograph changed-since\` reports ${contentDriftedFiles} ` +
    `file${contentDriftedFiles === 1 ? '' : 's'} content-drifted on disk vs the index — ` +
    'compare-to-ref uses `git diff` only; for the drifted set see `cartograph changed-since`._'
  );
}

export function renderCompareToRefCapture(capture: CompareToRefCapture): CompareToRefRender {
  if (capture.exitCode !== 0) {
    return { stream: 'stderr', text: `${capture.text}\n`, exitCode: capture.exitCode };
  }

  const drifted = capture.contentDriftedFiles;
  const shouldAppendHint = isEmptyCompareToRefText(capture.text) && drifted !== null && drifted > 0;
  const suffix = shouldAppendHint ? changedSinceDriftHint(drifted) : '';
  return { stream: 'stdout', text: `${capture.text}${suffix}\n`, exitCode: 0 };
}
