/**
 * Stable helper surface shared across `AgentTarget` implementations.
 *
 * The concrete ownership lives in feature-local target helper modules:
 * home resolution, MCP config construction, atomic/JSON/marked-section
 * writes, and Claude-style permissions. Keeping this file as a barrel
 * avoids noisy target churn while preserving those boundaries.
 */

export { getHomeDir } from './home.js';
export {
  getMcpCommand,
  getMcpServerArgs,
  getMcpServerConfig,
  isProjectSourceRunEntry,
  mcpCommandOptionsForLocation,
  renderMcpServersPrintConfig,
  type McpCommandOptions,
} from './mcp-config.js';
export { getCartographPermissions, writePermissionsAllowList } from './permissions.js';
export {
  asJsonObject,
  atomicWriteFileSync,
  deleteNestedJsonEntry,
  ensureNestedStringArray,
  getNestedJsonEntry,
  getNestedStringArray,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  removeNestedJsonEntry,
  removeOwnedFile,
  replaceOrAppendMarkedSection,
  setNestedJsonEntry,
  writeJsonFile,
  writeMarkedInstructionsFile,
  writeOwnedFile,
} from './file-writes.js';
