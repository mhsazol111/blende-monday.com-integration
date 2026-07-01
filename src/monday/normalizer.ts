import type { NormalizedEvent } from '../events/types.js';

/**
 * Maps a raw monday webhook `event` object into a canonical NormalizedEvent.
 *
 * monday payloads vary by event type and have historically used different
 * field names (pulseId vs itemId, etc.), so this reads defensively — mirroring
 * the variant-handling that was present in the former PHP plugin.
 */

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/** Pull a status label/index out of monday's various value shapes. */
function readStatus(value: any): { label?: string; index?: number } {
  if (!value || typeof value !== 'object') return {};
  const label = value.label;
  if (label && typeof label === 'object') {
    return { label: str(label.text), index: num(label.index) };
  }
  // Some payloads use { value: { index, text } } or flat fields.
  return { label: str(value.text), index: num(value.index) };
}

const COLUMN_CHANGE_TYPES = new Set([
  'update_column_value',
  'change_column_value',
  'change_specific_column_value',
  'change_status_column_value',
  'change_subitem_column_value', // subitem column change (delivered on the parent board)
  'change_subitem_name',
]);

const STATUS_COLUMN_TYPES = new Set(['color', 'status']);

export function normalizeEvent(rawEvent: Record<string, unknown>): NormalizedEvent {
  const e = rawEvent as any;
  const type = str(e.type) ?? 'unknown';

  const boardId = num(e.boardId ?? e.board_id) ?? 0;
  const itemId = num(e.pulseId ?? e.pulse_id ?? e.itemId ?? e.item_id) ?? 0;
  const eventId = str(e.triggerUuid ?? e.originalTriggerUuid ?? e.subscriptionId);

  const base = { boardId, raw: rawEvent, eventId };

  switch (type) {
    case 'create_pulse':
    case 'create_item':
      return {
        ...base,
        kind: 'item_entered_group',
        itemId,
        groupId: str(e.groupId ?? e.group_id) ?? '',
        reason: 'created',
      };

    case 'move_pulse_into_group':
      return {
        ...base,
        kind: 'item_entered_group',
        itemId,
        groupId: str(e.destGroupId ?? e.groupId ?? e.group_id) ?? '',
        reason: 'moved',
        fromGroupId: str(e.sourceGroupId ?? e.source_group_id ?? e.previousGroupId),
      };
  }

  if (COLUMN_CHANGE_TYPES.has(type)) {
    const columnId = str(e.columnId ?? e.column_id) ?? '';
    const columnType = str(e.columnType ?? e.column_type);
    const parentItemId = num(e.parentItemId ?? e.parent_item_id ?? e.parentId);
    const isSubitem = parentItemId !== undefined || type.startsWith('change_subitem');
    const isStatus =
      type === 'change_status_column_value' ||
      (columnType !== undefined && STATUS_COLUMN_TYPES.has(columnType));
    const { label, index } = readStatus(e.value);

    if (isSubitem) {
      return {
        ...base,
        kind: 'subitem_changed',
        subitemId: itemId,
        parentItemId,
        columnId,
        columnType,
        label,
        labelIndex: index,
        value: e.value,
      };
    }

    if (isStatus) {
      return {
        ...base,
        kind: 'status_changed',
        itemId,
        columnId,
        label,
        labelIndex: index,
        previousLabel: readStatus(e.previousValue).label,
      };
    }

    return {
      ...base,
      kind: 'column_changed',
      itemId,
      columnId,
      columnType,
      value: e.value,
    };
  }

  return { ...base, kind: 'unknown', type };
}
