/**
 * Persistence contracts. The engine depends on these interfaces (not on
 * SQLite directly) so it stays testable with an in-memory/mock store.
 */

export type QueuedActionType = 'email' | 'slack' | 'set_column' | 'post_update';
/**
 * `suppressed` = deliberately not delivered (today: the recipient is opted out of
 * email). Terminal like `sent` — never retried — but distinct so the UI can say
 * *why* nothing arrived instead of claiming a successful send.
 */
export type QueuedStatus = 'pending' | 'sent' | 'cancelled' | 'failed' | 'suppressed';

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
  /** Human-readable explanation for a terminal status (set for `suppressed`). */
  statusReason?: string;
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
  /** Cancel pending actions for an item; scope to `ruleIds` when provided (else all). */
  cancelPendingForItem(itemId: number, ruleIds?: string[]): number;
  getItemEntry(itemId: number): ItemEntry | null;
  recordItemEntry(itemId: number, boardId: number, groupId: string, enteredAt: number): void;
  clearItemEntry(itemId: number): void;
}

/** Full store, including what the worker + ingress dedupe need. */
export interface Store extends EngineStore {
  dueActions(now: number): QueuedActionRow[];
  markSent(id: number, sentAt: number): void;
  /** Terminal, deliberate non-delivery (e.g. the item is opted out of email). */
  markSuppressed(id: number, at: number, reason: string): void;
  markFailed(id: number): void;
  /** Cancel a single pending action by id (fire-time re-check skip). */
  markCancelled(id: number): void;
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
