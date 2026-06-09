export interface QuotedValue {
  value: string;
  end: number;
}

export function readQuoted(text: string, start: number): QuotedValue | null {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return { value: text.slice(start + 1, i), end: i + 1 };
    i++;
  }
  return null;
}
