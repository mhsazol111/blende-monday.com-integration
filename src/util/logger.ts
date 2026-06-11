import { env } from '../config/env.js';

/** Minimal leveled logger. Swap for pino/winston later if needed. */
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const threshold = LEVELS.indexOf((env.logLevel as Level) || 'info');

function emit(level: Level, msg: string, meta?: unknown) {
  if (LEVELS.indexOf(level) < threshold) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${level.toUpperCase()} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta !== undefined) out(line, meta);
  else out(line);
}

export const log = {
  debug: (msg: string, meta?: unknown) => emit('debug', msg, meta),
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
};
