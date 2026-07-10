import type * as http from 'node:http';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'none'",
].join('; ');

const VIEWER_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow, noarchive',
};

/** Apply the viewer's default browser-security policy before a route writes
 * response-specific headers. Static assets and event streams intentionally
 * replace `cache-control`; token-bearing HTML and JSON remain `no-store`. */
export function applyViewerResponseHeaders(res: http.ServerResponse): void {
  for (const [name, value] of Object.entries(VIEWER_RESPONSE_HEADERS)) {
    res.setHeader(name, value);
  }
}
