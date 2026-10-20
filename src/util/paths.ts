/**
 * OS-aware default paths. The token cache lives outside the repo so a
 * checkout can never carry credentials.
 */

import os from 'node:os';
import path from 'node:path';

/** Default cache directory: `~/.config/redmine-mcp` (or `%APPDATA%` on Windows). */
export function defaultCacheDir(): string {
  if (process.platform === 'win32' && process.env['APPDATA']) {
    return path.join(process.env['APPDATA'], 'redmine-mcp');
  }
  const base = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(base, 'redmine-mcp');
}
