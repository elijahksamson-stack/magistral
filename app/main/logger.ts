/**
 * Main-process logger.
 *
 * Deliberately tiny: this app has no logging dependency and does not want one.
 * The rule it enforces is the one that matters — nothing is ever swallowed.
 * Every catch in app/main/ routes here before it decides what to do next.
 */

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** `silent` is a threshold only — there is no logger.silent(). */
export type LogThreshold = LogLevel | 'silent';

const LEVEL_ORDER: Record<LogThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function isThreshold(value: unknown): value is LogThreshold {
  return typeof value === 'string' && value in LEVEL_ORDER;
}

/**
 * Tests exercise every failure path on purpose, so their expected errors would
 * bury a real one. Under vitest the default is silence; BRAINDUMP_LOG_LEVEL
 * overrides it when a test needs to see the output.
 */
function resolveThreshold(): LogThreshold {
  const override = process.env.BRAINDUMP_LOG_LEVEL;
  if (isThreshold(override)) return override;
  if (process.env.VITEST) return 'silent';
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const MIN_LEVEL: LogThreshold = resolveThreshold();
const FALLBACK_LOG_PATH = path.join(tmpdir(), 'braindump.log');

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function write(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  if (!shouldLog(level)) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${message}`;
  const text = detail === undefined ? `${line}\n` : `${line} ${formatDetail(detail)}\n`;

  try {
    // A Windows GUI process launched from Explorer has no console handles;
    // merely reading process.stdout/process.stderr can throw EBADF there.
    const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    sink.write(text);
    return;
  } catch {
    // Keep production diagnostics even without a console. Logging must never
    // become the crash it was trying to describe.
  }

  try {
    appendFileSync(FALLBACK_LOG_PATH, text, 'utf8');
  } catch {
    // There is no safe third sink. In particular, console.* uses the same
    // unavailable stdio handles and would recurse into this failure.
  }
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, detail) => write('debug', scope, message, detail),
    info: (message, detail) => write('info', scope, message, detail),
    warn: (message, detail) => write('warn', scope, message, detail),
    error: (message, detail) => write('error', scope, message, detail),
  };
}

/** Narrow an unknown thrown value to a readable message. Never returns ''. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Unexpected error';
}
