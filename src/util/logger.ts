/**
 * Structured stderr logging. Stdout carries MCP framing under `serve`, so
 * every log line goes to stderr and nothing here ever touches stdout.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function format(level: LogLevel, message: string, fields?: Record<string, unknown>): string {
  const base = `[redmine-mcp] [${level}] ${message}`;
  if (fields === undefined || Object.keys(fields).length === 0) return `${base}\n`;
  return `${base} ${JSON.stringify(fields)}\n`;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const emit = (entry: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[entry] < ORDER[level]) return;
    try {
      process.stderr.write(format(entry, message, fields));
    } catch {
      // A closed stderr must not turn anything into a crash.
    }
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/** Process-wide logger. `serve` replaces it with a verbose-aware one. */
export let logger: Logger = createLogger('info');

export function setLogger(next: Logger): void {
  logger = next;
}
