import * as fs from 'node:fs';
import { TextDecoder } from 'node:util';
import { errMsg, logWarn } from './errors.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface ReadControlFileOptions {
  label: string;
  onUnreadable?: 'warn';
}

/**
 * Read a small project-control file whose grammar is text-only
 * (`.gitignore`, `.ignore`, etc.). Binary or invalid UTF-8 content is
 * treated as absent so encrypted/DLP-corrupted files cannot derail indexing
 * or get appended to during init.
 */
export function readUtf8ControlFile(filePath: string, options: ReadControlFileOptions): string | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if (options.onUnreadable === 'warn') {
      logWarn(`Skipping unreadable ${options.label}`, { path: filePath, error: errMsg(error) });
    }
    return null;
  }

  if (bytes.includes(0)) {
    logWarn(`Skipping binary ${options.label}`, { path: filePath, reason: 'contains NUL bytes' });
    return null;
  }

  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    logWarn(`Skipping invalid UTF-8 ${options.label}`, { path: filePath, error: errMsg(error) });
    return null;
  }
}
