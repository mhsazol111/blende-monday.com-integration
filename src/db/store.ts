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
  }

  // ── queue ────────────────────────────────────────────────────────────────
  enqueue(entry: QueueEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO queued_actions (item_id, rule_id, action_type, payload_json, due_at, status, dedupe_key, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          entry.itemId,
          entry.ruleId,
          entry.actionType,
          JSON.stringify(entry.payload),
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

  cancelPendingForItem(itemId: number): number {
    const res = this.db
      .prepare(`UPDATE queued_actions SET status = 'cancelled' WHERE item_id = ? AND status = 'pending'`)
      .run(itemId);
    return Number(res.changes ?? 0);
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

  markFailed(id: number): void {
    this.db.prepare(`UPDATE queued_actions SET status = 'failed' WHERE id = ?`).run(id);
  }

  retryLater(id: number, nextDueAt: number): void {
    this.db
      .prepare(`UPDATE queued_actions SET attempts = attempts + 1, due_at = ? WHERE id = ?`)
      .run(nextDueAt, id);
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
    dueAt: Number(row.due_at),
    status: String(row.status) as QueuedStatus,
    attempts: Number(row.attempts ?? 0),
    dedupeKey: row.dedupe_key ?? undefined,
    createdAt: Number(row.created_at),
    sentAt: row.sent_at === null ? null : Number(row.sent_at),
  };
}
