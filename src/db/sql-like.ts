const BACKSLASH = String.fromCodePoint(92);

export function escapeLike(s: string): string {
  return s
    .replaceAll(BACKSLASH, BACKSLASH + BACKSLASH)
    .replaceAll('_', BACKSLASH + '_')
    .replaceAll('%', BACKSLASH + '%');
}

export function prefixLikePattern(prefix: string | undefined): string {
  return prefix && prefix.length > 0 ? `${escapeLike(prefix)}%` : '%';
}
