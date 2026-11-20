/**
 * Minimal structured logger.
 *
 * Single-line events with an ISO-8601 timestamp, level, tag, and structured
 * fields rendered as `key=value` pairs (quoted only when needed). Designed
 * for `tail -f` and `grep` in dev; trivially re-parseable by a log shipper
 * later because the leading tokens (`<ts> <LEVEL> <tag>`) are positional.
 *
 * Example output:
 *   2026-05-17T16:30:12.345Z INFO  api.request    method=POST path=/workspaces/ws_abc/candidates/groups status=200 ms=42114
 *   2026-05-17T16:30:12.502Z INFO  synth.cache    task=emit_groups cache_read=1452 input=7344 output=2649 ms=4810
 *   2026-05-17T16:31:45.110Z ERROR api.uncaught   method=POST path=/workspaces/ws_abc/ingest/file ws=ws_abc msg="ZodError: ..."
 *
 * Levels honour POMEGRANATE_LOG_LEVEL (`debug` | `info` | `warn` | `error`),
 * default `info`. Lower-priority events are dropped.
 *
 * Sinks:
 *   - stdout (info/debug) and stderr (warn/error), for `tail -f` in dev
 *   - appended to a single file (`POMEGRANATE_APP_LOG_PATH`, default
 *     `./data/app.log`, sibling of `pomegranate.db` / `llm.log`) so the
 *     full backend timeline survives across server restarts. File-write
 *     failure is reported once on stderr but never throws — logging must
 *     not break the request that triggered it.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = (() => {
  const raw = (process.env.POMEGRANATE_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
})();

const TAG_WIDTH = 14;
const LEVEL_TAGS: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/**
 * Render a single field value. Strings with whitespace or special chars are
 * quoted; numbers and booleans pass through; objects are JSON-stringified.
 */
function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    if (/[\s"=]/.test(v)) {
      return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    return v;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return '<unserializable>';
  }
}

function format(level: LogLevel, tag: string, fields: Record<string, unknown> | undefined): string {
  const ts = new Date().toISOString();
  const pad = tag.length < TAG_WIDTH ? tag + ' '.repeat(TAG_WIDTH - tag.length) : tag;
  let line = `${ts} ${LEVEL_TAGS[level]} ${pad}`;
  if (fields) {
    for (const k of Object.keys(fields)) {
      line += ` ${k}=${renderValue(fields[k])}`;
    }
  }
  return line;
}

const FILE_PATH = process.env.POMEGRANATE_APP_LOG_PATH ?? resolve(process.cwd(), 'data', 'app.log');
let fileInitialized = false;
let fileBroken = false;
function appendToFile(line: string): void {
  if (fileBroken) return;
  try {
    if (!fileInitialized) {
      mkdirSync(dirname(FILE_PATH), { recursive: true });
      fileInitialized = true;
    }
    appendFileSync(FILE_PATH, line + '\n');
  } catch (err) {
    fileBroken = true;
    process.stderr.write(
      `${new Date().toISOString()} ERROR log.file_sink   path=${FILE_PATH} msg="${(err as Error).message}"\n`,
    );
  }
}

function emit(level: LogLevel, tag: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < THRESHOLD) return;
  const line = format(level, tag, fields);
  // stderr for warn+, stdout for info/debug. Single write so lines don't interleave.
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
  appendToFile(line);
}

export const log = {
  debug(tag: string, fields?: Record<string, unknown>): void {
    emit('debug', tag, fields);
  },
  info(tag: string, fields?: Record<string, unknown>): void {
    emit('info', tag, fields);
  },
  warn(tag: string, fields?: Record<string, unknown>): void {
    emit('warn', tag, fields);
  },
  error(tag: string, fields?: Record<string, unknown>): void {
    emit('error', tag, fields);
  },
};
