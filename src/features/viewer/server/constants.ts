export interface IntBound {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

import { resolveGitBinary } from '../../../git-utils.js';

export const DEFAULT_PORT = 8765;
/* A concrete loopback address, NOT 'localhost': under Bun, 'localhost'
   alternates between ::1 and 127.0.0.1 across binds, letting two
   viewers "share" a port on different address families (and browsers
   resolve to either). One database = one viewer = one socket. */
export const DEFAULT_HOST = '127.0.0.1';
export const HTTP_SCHEME = 'http://';
export const URL_PARSE_BASE = `${HTTP_SCHEME}localhost`;
export const GIT_BINARY = resolveGitBinary();

export const HTTP_OK = 200;
export const HTTP_NOT_MODIFIED = 304;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_METHOD_NOT_ALLOWED = 405;
export const HTTP_PAYLOAD_TOO_LARGE = 413;
export const HTTP_INTERNAL_ERROR = 500;
export const HTTP_SERVICE_UNAVAILABLE = 503;

export const GRAPH_DEPTH: IntBound = { min: 1, max: 4, default: 2 };
export const GRAPH_LIMIT: IntBound = { min: 1, max: 300, default: 80 };
export const HOTSPOTS_LIMIT: IntBound = { min: 1, max: 100, default: 12 };
export const BIOMARKER_LIMIT: IntBound = { min: 1, max: 200, default: 50 };
export const SESSIONS_LIMIT: IntBound = { min: 1, max: 50, default: 10 };
export const SEARCH_LIMIT: IntBound = { min: 1, max: 30, default: 8 };
export const IMPACT_DEPTH: IntBound = { min: 1, max: 4, default: 2 };
export const IMPACT_LIMIT: IntBound = { min: 1, max: 300, default: 120 };
export const COMPARE_LIMIT: IntBound = { min: 1, max: 200, default: 80 };

export const GRAPH_BFS_LIMIT = 60;
export const DEFAULT_GRAPH_ROOT_CANDIDATES = 28;
export const STATIC_ASSET_CACHE_CONTROL = 'no-cache';
export const VIEWER_EXCLUDED_EDGE_KINDS = new Set(['similar_to', 'def_use']);

export const ASK_BODY_BYTE_LIMIT = 64 * 1024;
export const ASK_QUESTION_CHAR_LIMIT = 8000;
export const ASK_SYMBOL_CHAR_LIMIT = 200;
export const ASK_SELECTION_CHAR_LIMIT = 8000;
export const ASK_RETRIEVE_K = 12;
export const ASK_CITATION_LIMIT = 8;

export const LIVE_BACKLOG_LIMIT: IntBound = { min: 1, max: 200, default: 40 };
export const LIVE_CALLS_BATCH_LIMIT = 500;
export const LIVE_POLL_INTERVAL_MS = 500;
export const LIVE_HEARTBEAT_MS = 15_000;

export const HEALTH_BASELINE = 10;
export const HEALTH_FLOOR = 1;
export const HEALTH_PENALTY_ERROR = 2;
export const HEALTH_PENALTY_WARNING = 1;
export const HEALTH_PENALTY_INFO = 0.5;
export const HEALTH_DECIMAL_RESOLUTION = 10;
