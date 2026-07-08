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
