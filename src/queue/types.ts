/**
 * Persistence contracts. The engine depends on these interfaces (not on
 * SQLite directly) so it stays testable with an in-memory/mock store.
 */

import type { Action } from '../rules/types.js';

export type QueuedActionType = 'email' | 'slack' | 'set_column' | 'post_update' | 'move_item_to_group';

/**
 * Event-derived context a re-render can't recover from the item alone, captured
 * when the action is armed:
 * - `status` — the label the triggering event carried (a `status_changed` trigger
 *   fired *because* of it, so `{{status}}` should keep meaning that, not whatever
 *   the column reads days later).
 * - `subitemName` — the subitem that triggered the rule; re-resolved against the
 *   fresh item at send time so `{{subitem.*}}` shows current values.
 */
export interface RenderHints {
  status?: string;
  subitemName?: string;
}

/**
 * Everything needed to re-render a queued action against fresh monday data at
 * send time. Without it a delayed message describes the item as it was when the
 * rule armed — days or weeks earlier. Optional: rows queued before this shipped
 * have none and are sent exactly as rendered.
 */
export interface RenderEnvelope {
  action: Action;
  hints: RenderHints;
}
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
  /** Payload rendered when the action was armed — the fallback if a re-render can't run. */
  payload: unknown;
  /** Raw action + event hints, so the payload can be re-rendered at send time. */
  render?: RenderEnvelope;
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

/** Admin queue listing: filters + a page window. Omitted filters match everything. */
export interface QueueQuery {
  status?: QueuedStatus;
  actionType?: string;
  ruleId?: string;
  itemId?: number;
  /** Page size (clamped by the store). */
  limit?: number;
  offset?: number;
}

export interface QueuePage {
  actions: QueuedActionRow[];
  /** Rows matching the filter across the whole table — drives the pager. */
  total: number;
  limit: number;
  offset: number;
}

/** Distinct filter values, so the dropdowns aren't limited to the current page. */
export interface QueueFacets {
  statuses: string[];
  actionTypes: string[];
  ruleIds: string[];
  itemIds: number[];
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
  /**
   * One page of actions, most-recent first, plus the total number of rows
   * matching the filter (not the page). Filtering happens in SQL so "status =
   * pending" means every pending row, not just the pending ones that happen to
   * fall inside the page.
   */
  listActions(query?: QueueQuery): QueuePage;
  /** Distinct values for the admin filter dropdowns, across the whole table. */
  queueFacets(): QueueFacets;
  getAction(id: number): QueuedActionRow | null;
  /** Reschedule a pending/failed/sent action to a new due time (resets to pending). */
  rescheduleAction(id: number, dueAt: number): void;
  /** Permanently remove an action row. */
  deleteAction(id: number): void;
  /** Permanently remove several action rows; returns how many were deleted. */
  deleteActions(ids: number[]): number;
  close(): void;
}
