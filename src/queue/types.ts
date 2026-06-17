/**
 * Persistence contracts. The engine depends on these interfaces (not on
 * SQLite directly) so it stays testable with an in-memory/mock store.
 */

export type QueuedActionType = 'email' | 'slack' | 'set_column';
export type QueuedStatus = 'pending' | 'sent' | 'cancelled' | 'failed';

export interface QueueEntry {
  itemId: number;
  ruleId: string;
  actionType: QueuedActionType;
  /** Fully-rendered payload (EmailMessage | SlackMessage) — sent as-is later. */
  payload: unknown;
  /** Epoch ms when the action becomes due. */
  dueAt: number;
  /** Optional idempotency key to avoid duplicate scheduling. */
  dedupeKey?: string;
}

export interface QueuedActionRow extends QueueEntry {
  id: number;
  status: QueuedStatus;
  attempts: number;
  createdAt: number;
  sentAt: number | null;
}

export interface ItemEntry {
  itemId: number;
  boardId: number;
  groupId: string;
  enteredAt: number;
}

/** What the rules engine needs from persistence. */
export interface EngineStore {
  enqueue(entry: QueueEntry): void;
  cancelPendingForItem(itemId: number): number;
  getItemEntry(itemId: number): ItemEntry | null;
  recordItemEntry(itemId: number, boardId: number, groupId: string, enteredAt: number): void;
  clearItemEntry(itemId: number): void;
}

/** Full store, including what the worker + ingress dedupe need. */
export interface Store extends EngineStore {
  dueActions(now: number): QueuedActionRow[];
  markSent(id: number, sentAt: number): void;
  markFailed(id: number): void;
  /** Increment attempts and reschedule for a later retry (keeps status pending). */
  retryLater(id: number, nextDueAt: number): void;
  hasProcessedEvent(eventId: string): boolean;
  markProcessedEvent(eventId: string, at: number): void;
  // ── queue management (admin UI) ──
  /** Most-recent actions first (all statuses), capped by `limit`. */
  listActions(limit?: number): QueuedActionRow[];
  getAction(id: number): QueuedActionRow | null;
  /** Reschedule a pending/failed/sent action to a new due time (resets to pending). */
  rescheduleAction(id: number, dueAt: number): void;
  /** Permanently remove an action row. */
  deleteAction(id: number): void;
  close(): void;
}
