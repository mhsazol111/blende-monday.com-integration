import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import type {
  ItemEntry,
  QueueEntry,
  QueuedActionRow,
  QueuedActionType,
  QueuedStatus,
  QueueFacets,
  QueuePage,
  QueueQuery,
  RenderEnvelope,
  Store,
} from '../queue/types.js';

/**
 * SQLite-backed store (Node's built-in `node:sqlite`). Schema mirrors CLAUDE.md
 * §3; it is intentionally plain SQL so it ports to Postgres later. Pass
 * `:memory:` for tests.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(path = env.databasePath) {
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queued_actions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id      INTEGER NOT NULL,
        rule_id      TEXT    NOT NULL,
        action_type  TEXT    NOT NULL,
        payload_json TEXT    NOT NULL,
        due_at       INTEGER NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'pending',
        attempts     INTEGER NOT NULL DEFAULT 0,
        dedupe_key   TEXT,
        created_at   INTEGER NOT NULL,
        sent_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_queued_due ON queued_actions (status, due_at);
      CREATE INDEX IF NOT EXISTS idx_queued_item ON queued_actions (item_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_dedupe
        ON queued_actions (dedupe_key) WHERE dedupe_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS item_group_state (
        item_id    INTEGER PRIMARY KEY,
        board_id   INTEGER NOT NULL,
        group_id   TEXT    NOT NULL,
        entered_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        event_id     TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );
    `);

    // Added after the initial schema shipped, so existing databases need an
    // ALTER. `CREATE TABLE IF NOT EXISTS` above is a no-op on those.
    this.addColumnIfMissing('queued_actions', 'status_reason', 'TEXT');
    this.addColumnIfMissing('queued_actions', 'render_json', 'TEXT');
  }

  /** Idempotent `ALTER TABLE … ADD COLUMN` (SQLite has no `IF NOT EXISTS` for it). */
  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    log.info(`DB migration: added ${table}.${column}.`);
  }

  // ── queue ────────────────────────────────────────────────────────────────
  enqueue(entry: QueueEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO queued_actions (item_id, rule_id, action_type, payload_json, render_json, due_at, status, dedupe_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          entry.itemId,
          entry.ruleId,
          entry.actionType,
          JSON.stringify(entry.payload),
          entry.render ? JSON.stringify(entry.render) : null,
          entry.dueAt,
          entry.dedupeKey ?? null,
          Date.now(),
        );
    } catch (err: any) {
      // Unique dedupe_key collision = already scheduled; ignore.
      if (String(err?.message ?? '').includes('UNIQUE')) {
        log.debug(`enqueue skipped (duplicate dedupe_key ${entry.dedupeKey}).`);
        return;
      }
      throw err;
    }
  }

  cancelPendingForItem(itemId: number, ruleIds?: string[]): number {
    if (ruleIds && ruleIds.length) {
      const placeholders = ruleIds.map(() => '?').join(',');
      const res = this.db
        .prepare(
          `UPDATE queued_actions SET status = 'cancelled' WHERE item_id = ? AND status = 'pending' AND rule_id IN (${placeholders})`,
        )
        .run(itemId, ...ruleIds);
      return Number(res.changes ?? 0);
    }
    const res = this.db
      .prepare(`UPDATE queued_actions SET status = 'cancelled' WHERE item_id = ? AND status = 'pending'`)
      .run(itemId);
    return Number(res.changes ?? 0);
  }

  /** Cancel a single pending action by id (used by the worker's fire-time gate). */
  markCancelled(id: number): void {
    this.db.prepare(`UPDATE queued_actions SET status = 'cancelled' WHERE id = ?`).run(id);
  }

  dueActions(now: number): QueuedActionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM queued_actions WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC`)
      .all(now) as any[];
    return rows.map(rowToQueuedAction);
  }

  markSent(id: number, sentAt: number): void {
    this.db.prepare(`UPDATE queued_actions SET status = 'sent', sent_at = ? WHERE id = ?`).run(sentAt, id);
  }

  markSuppressed(id: number, at: number, reason: string): void {
    this.db
      .prepare(`UPDATE queued_actions SET status = 'suppressed', sent_at = ?, status_reason = ? WHERE id = ?`)
      .run(at, reason, id);
  }

  markFailed(id: number): void {
    this.db.prepare(`UPDATE queued_actions SET status = 'failed' WHERE id = ?`).run(id);
  }

  retryLater(id: number, nextDueAt: number): void {
    this.db
      .prepare(`UPDATE queued_actions SET attempts = attempts + 1, due_at = ? WHERE id = ?`)
      .run(nextDueAt, id);
  }

  // ── queue management (admin UI) ────────────────────────────────────────────
  /**
   * One page of the queue plus the total matching the filter.
   *
   * Filtering is done in SQL rather than in the browser: the list used to fetch
   * the newest 200 rows and filter them client-side, so once the table passed
   * 200 an older pending action was invisible in the UI even though the worker
   * would still fire it. `total` counts matches across the whole table, so the
   * pager can say "1–50 of 812".
   */
  listActions(query: QueueQuery = {}): QueuePage {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.status) { where.push('status = ?'); args.push(query.status); }
    if (query.actionType) { where.push('action_type = ?'); args.push(query.actionType); }
    if (query.ruleId) { where.push('rule_id = ?'); args.push(query.ruleId); }
    if (query.itemId != null && !Number.isNaN(query.itemId)) { where.push('item_id = ?'); args.push(query.itemId); }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM queued_actions${clause}`).get(...args) as any)?.n ?? 0,
    );
    const rows = this.db
      .prepare(`SELECT * FROM queued_actions${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as any[];
    return { actions: rows.map(rowToQueuedAction), total, limit, offset };
  }

  queueFacets(): QueueFacets {
    const col = (sql: string) => (this.db.prepare(sql).all() as any[]).map((r) => r.v).filter((v) => v != null && v !== '');
    return {
      statuses: col(`SELECT DISTINCT status AS v FROM queued_actions ORDER BY v`),
      actionTypes: col(`SELECT DISTINCT action_type AS v FROM queued_actions ORDER BY v`),
      ruleIds: col(`SELECT DISTINCT rule_id AS v FROM queued_actions ORDER BY v`),
      // Newest items first — an operator is nearly always after a recent one.
      itemIds: col(`SELECT item_id AS v FROM queued_actions GROUP BY item_id ORDER BY MAX(created_at) DESC`).map(Number),
    };
  }

  getAction(id: number): QueuedActionRow | null {
    const row = this.db.prepare(`SELECT * FROM queued_actions WHERE id = ?`).get(id) as any;
    return row ? rowToQueuedAction(row) : null;
  }

  rescheduleAction(id: number, dueAt: number): void {
    this.db
      .prepare(`UPDATE queued_actions SET due_at = ?, status = 'pending', sent_at = NULL WHERE id = ?`)
      .run(dueAt, id);
  }

  deleteAction(id: number): void {
    this.db.prepare(`DELETE FROM queued_actions WHERE id = ?`).run(id);
  }

  /** Bulk delete by id. One statement, so a long selection is still one trip. */
  deleteActions(ids: number[]): number {
    const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n)))];
    if (!clean.length) return 0;
    const placeholders = clean.map(() => '?').join(',');
    const res = this.db.prepare(`DELETE FROM queued_actions WHERE id IN (${placeholders})`).run(...clean);
    return Number(res.changes ?? 0);
  }

  // ── item group state ───────────────────────────────────────────────────────
  getItemEntry(itemId: number): ItemEntry | null {
    const row = this.db.prepare(`SELECT * FROM item_group_state WHERE item_id = ?`).get(itemId) as any;
    if (!row) return null;
    return {
      itemId: Number(row.item_id),
      boardId: Number(row.board_id),
      groupId: String(row.group_id),
      enteredAt: Number(row.entered_at),
    };
  }

  recordItemEntry(itemId: number, boardId: number, groupId: string, enteredAt: number): void {
    this.db
      .prepare(
        `INSERT INTO item_group_state (item_id, board_id, group_id, entered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET board_id = excluded.board_id,
           group_id = excluded.group_id, entered_at = excluded.entered_at`,
      )
      .run(itemId, boardId, groupId, enteredAt);
  }

  clearItemEntry(itemId: number): void {
    this.db.prepare(`DELETE FROM item_group_state WHERE item_id = ?`).run(itemId);
  }

  // ── event dedupe ─────────────────────────────────────────────────────────
  hasProcessedEvent(eventId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM processed_events WHERE event_id = ?`).get(eventId);
  }

  markProcessedEvent(eventId: string, at: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)`)
      .run(eventId, at);
  }

  close(): void {
    this.db.close();
  }
}

function rowToQueuedAction(row: any): QueuedActionRow {
  return {
    id: Number(row.id),
    itemId: Number(row.item_id),
    ruleId: String(row.rule_id),
    actionType: String(row.action_type) as QueuedActionType,
    payload: JSON.parse(row.payload_json),
    render: parseRender(row.render_json),
    dueAt: Number(row.due_at),
    status: String(row.status) as QueuedStatus,
    statusReason: row.status_reason ?? undefined,
    attempts: Number(row.attempts ?? 0),
    dedupeKey: row.dedupe_key ?? undefined,
    createdAt: Number(row.created_at),
    sentAt: row.sent_at === null ? null : Number(row.sent_at),
  };
}

/**
 * Null for rows queued before re-rendering shipped (they send as armed). Bad JSON
 * is treated the same way rather than throwing — a corrupt envelope must not stop
 * the queue from draining.
 */
function parseRender(json: unknown): RenderEnvelope | undefined {
  if (typeof json !== 'string' || !json) return undefined;
  try {
    return JSON.parse(json) as RenderEnvelope;
  } catch {
    log.warn('Queued action has unreadable render_json; it will be sent as originally rendered.');
    return undefined;
  }
}
