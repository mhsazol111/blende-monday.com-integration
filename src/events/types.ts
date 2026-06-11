/**
 * Canonical internal events. The normalizer maps sparse, differently-shaped
 * monday webhook payloads into this small, stable vocabulary; the rules engine
 * (Phase 3) then matches these against rule triggers.
 *
 * NOTE: exact monday field names are handled defensively in the normalizer and
 * will be reconciled against real captured payloads during live testing.
 */

export interface BaseEvent {
  /** monday board the event occurred on. */
  boardId: number;
  /** Raw monday `event` object, kept for debugging / later hydration. */
  raw: Record<string, unknown>;
  /** monday's trigger uuid / subscription id, when present (for dedupe). */
  eventId?: string;
}

/** Item created in a group, or moved into one. */
export interface ItemEnteredGroupEvent extends BaseEvent {
  kind: 'item_entered_group';
  itemId: number;
  groupId: string;
  reason: 'created' | 'moved';
}

/** Item moved out of a group (best-effort; previous group not always present). */
export interface ItemLeftGroupEvent extends BaseEvent {
  kind: 'item_left_group';
  itemId: number;
  fromGroupId?: string;
}

/** A status (color) column on an item changed to a label. */
export interface StatusChangedEvent extends BaseEvent {
  kind: 'status_changed';
  itemId: number;
  columnId: string;
  label?: string;
  labelIndex?: number;
  previousLabel?: string;
}

/** A non-status column on an item changed. */
export interface ColumnChangedEvent extends BaseEvent {
  kind: 'column_changed';
  itemId: number;
  columnId: string;
  columnType?: string;
  value: unknown;
}

/** A column on a SUBITEM changed (subitems live on their own board). */
export interface SubitemChangedEvent extends BaseEvent {
  kind: 'subitem_changed';
  subitemId: number;
  parentItemId?: number;
  columnId: string;
  columnType?: string;
  label?: string;
  labelIndex?: number;
  value: unknown;
}

/** Item moved to another board (workspace moves surface this way). */
export interface ItemMovedBoardEvent extends BaseEvent {
  kind: 'item_moved_board';
  itemId: number;
  toBoardId?: number;
}

/** Anything we don't yet map — logged so we can learn real payload shapes. */
export interface UnknownEvent extends BaseEvent {
  kind: 'unknown';
  type: string;
}

export type NormalizedEvent =
  | ItemEnteredGroupEvent
  | ItemLeftGroupEvent
  | StatusChangedEvent
  | ColumnChangedEvent
  | SubitemChangedEvent
  | ItemMovedBoardEvent
  | UnknownEvent;
