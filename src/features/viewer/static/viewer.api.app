/* API fetch wrapper. The live server injects the per-server token into
   the meta tag; standalone file:// mockups keep the tag empty and fall
   back to normal fetch behavior. */
const VIEWER_API_TOKEN_META = 'meta[name="cartograph-viewer-token"]';

function viewerApiToken() {
  return document.querySelector(VIEWER_API_TOKEN_META)?.content || '';
}

function isViewerApiRequest(input) {
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl, globalThis.location.href);
    return url.origin === globalThis.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function apiFetch(input, init = {}) {
  const token = viewerApiToken();
  if (!token || !isViewerApiRequest(input)) return fetch(input, init);
  const headers = new Headers(init.headers || {});
  headers.set('x-cartograph-viewer-token', token);
  return fetch(input, { ...init, headers });
}
