import { mondayGraphql } from './client.js';

/**
 * Write a value back to monday (the `set_column` action). Uses
 * `change_simple_column_value`, which accepts a simple string and lets monday
 * coerce it per column type: status/color → the label INDEX, text → the text,
 * date → "YYYY-MM-DD", numbers → the number, etc. Works for both items and
 * subitems (a subitem is just an item on the subitem board).
 *
 * The call is injectable (`ColumnWriter`) so the engine can be tested offline.
 */

export interface SetColumnArgs {
  boardId: number;
  itemId: number;
  columnId: string;
  value: string;
}

export type ColumnWriter = (args: SetColumnArgs) => Promise<void>;

const MUTATION = `
  mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String) {
    change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
      id
    }
  }
`;

export const setColumnValue: ColumnWriter = async ({ boardId, itemId, columnId, value }) => {
  await mondayGraphql(MUTATION, {
    boardId: String(boardId),
    itemId: String(itemId),
    columnId,
    value,
  });
};

/**
 * Post an item Update (the `post_update` action). Uses `create_update`, whose
 * `body` accepts a subset of HTML for rich formatting and has NO ~2000-char
 * long_text column cap — the right home for long content a human reads/copies.
 * Works for both items and subitems (a subitem is just an item on the subitem
 * board), so callers pass the resolved item/subitem id.
 *
 * Injectable (`UpdateWriter`) so the engine can be tested offline.
 */

export interface PostUpdateArgs {
  itemId: number;
  body: string;
}

export type UpdateWriter = (args: PostUpdateArgs) => Promise<void>;

const UPDATE_MUTATION = `
  mutation ($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) {
      id
    }
  }
`;

export const postItemUpdate: UpdateWriter = async ({ itemId, body }) => {
  await mondayGraphql(UPDATE_MUTATION, {
    itemId: String(itemId),
    body,
  });
};

/**
 * Move an item to another group (the `move_item_to_group` action). The
 * destination is given as free text — a group **id** or a group **title** —
 * because it usually comes from a column value (e.g. a "Move To" status column
 * whose labels are the group titles), rendered at event time.
 *
 * Resolution and the already-there check happen HERE, at send time, in one
 * round-trip that reads the board's groups and the item's current group
 * together: a scheduled move must not act on a stale snapshot, and a rename
 * between arming and firing should still resolve.
 *
 * Never throws for a bad destination — an unknown group name won't fix itself
 * on retry, so it reports `moved: false` and the caller logs it.
 *
 * Injectable (`GroupMover`) so the engine can be tested offline.
 */

export interface MoveToGroupArgs {
  boardId: number;
  itemId: number;
  /** Group id or group title; matched case-insensitively after trimming. */
  group: string;
}

export interface MoveResult {
  moved: boolean;
  reason?: string;
  groupId?: string;
  groupTitle?: string;
}

export type GroupMover = (args: MoveToGroupArgs) => Promise<MoveResult>;

const MOVE_LOOKUP = `
  query ($boardId: [ID!], $itemId: [ID!]) {
    boards(ids: $boardId) { groups { id title } }
    items(ids: $itemId) { id group { id title } }
  }
`;

const MOVE_MUTATION = `
  mutation ($itemId: ID!, $groupId: String!) {
    move_item_to_group(item_id: $itemId, group_id: $groupId) {
      id
    }
  }
`;

const norm = (s: string) => s.trim().toLowerCase();

export const moveItemToGroup: GroupMover = async ({ boardId, itemId, group }) => {
  const wanted = group.trim();
  if (!wanted) return { moved: false, reason: 'no destination group given' };

  const data = await mondayGraphql<{
    boards: { groups: { id: string; title: string }[] }[];
    items: { id: string; group: { id: string; title: string } | null }[];
  }>(MOVE_LOOKUP, { boardId: [String(boardId)], itemId: [String(itemId)] });

  const groups = data.boards?.[0]?.groups ?? [];
  const target =
    groups.find((g) => g.id === wanted) ?? groups.find((g) => norm(g.title) === norm(wanted));
  if (!target) {
    return { moved: false, reason: `no group on board ${boardId} matches “${wanted}”` };
  }

  const current = data.items?.[0]?.group?.id;
  if (current && current === target.id) {
    // Moving an item to where it already is would re-fire every
    // item_entered_group rule for that group (re-cloning, re-emailing).
    return { moved: false, reason: 'item is already in that group', groupId: target.id, groupTitle: target.title };
  }

  await mondayGraphql(MOVE_MUTATION, { itemId: String(itemId), groupId: target.id });
  return { moved: true, groupId: target.id, groupTitle: target.title };
};
