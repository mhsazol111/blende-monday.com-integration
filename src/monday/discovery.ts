import { mondayGraphql } from './client.js';

/**
 * Board-structure discovery. This is the source of every ID the rules engine
 * (and the future configurator UI) needs: group ids, column ids/types, status
 * labels, and the subitem board's columns. Nothing here mutates monday.
 */

export interface GroupInfo {
  id: string;
  title: string;
}

export interface StatusLabel {
  index: string;
  label: string;
}

export interface ColumnInfo {
  id: string;
  title: string;
  type: string;
  /** For status/dropdown columns: the available labels and their indices. */
  labels?: StatusLabel[];
  /** For subitems columns: the linked subitem board id(s). */
  subitemBoardIds?: string[];
}

export interface BoardStructure {
  id: string;
  name: string;
  groups: GroupInfo[];
  columns: ColumnInfo[];
  /** Discovered subitem board id (from the subitems column settings), if any. */
  subitemBoardId?: string;
}

interface RawColumn {
  id: string;
  title: string;
  type: string;
  settings_str: string | null;
}

interface RawBoard {
  id: string;
  name: string;
  groups: GroupInfo[];
  columns: RawColumn[];
}

const BOARD_STRUCTURE_QUERY = `
  query ($boardId: [ID!]) {
    boards(ids: $boardId) {
      id
      name
      groups { id title }
      columns { id title type settings_str }
    }
  }
`;

/** Parse a status/dropdown column's settings_str into label list. */
function parseLabels(settings: any): StatusLabel[] | undefined {
  const labels = settings?.labels;
  if (!labels || typeof labels !== 'object') return undefined;
  // Modern status columns: { "1": "Done", "2": "Stuck" }.
  return Object.entries(labels)
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([index, label]) => ({ index, label: String(label) }));
}

/** Parse a subitems column's settings_str for linked board ids. */
function parseSubitemBoardIds(settings: any): string[] | undefined {
  const ids = settings?.boardIds;
  if (!Array.isArray(ids) || ids.length === 0) return undefined;
  return ids.map((id: unknown) => String(id));
}

function mapColumn(raw: RawColumn): ColumnInfo {
  let settings: any = {};
  if (raw.settings_str) {
    try {
      settings = JSON.parse(raw.settings_str);
    } catch {
      settings = {};
    }
  }
  const col: ColumnInfo = { id: raw.id, title: raw.title, type: raw.type };
  const labels = parseLabels(settings);
  if (labels) col.labels = labels;
  const subitemBoardIds = parseSubitemBoardIds(settings);
  if (subitemBoardIds) col.subitemBoardIds = subitemBoardIds;
  return col;
}

export async function getBoardStructure(boardId: string | number): Promise<BoardStructure> {
  const data = await mondayGraphql<{ boards: RawBoard[] }>(BOARD_STRUCTURE_QUERY, {
    boardId: [String(boardId)],
  });

  const board = data.boards?.[0];
  if (!board) {
    throw new Error(`Board ${boardId} not found (or token lacks access).`);
  }

  const columns = board.columns.map(mapColumn);
  const subitemBoardId = columns
    .flatMap((c) => c.subitemBoardIds ?? [])
    .find(Boolean);

  return {
    id: board.id,
    name: board.name,
    groups: board.groups ?? [],
    columns,
    subitemBoardId,
  };
}

/**
 * Full discovery: the parent board plus its subitem board's columns (if any).
 * Subitem columns are what `subitem_checked` rules reference.
 */
export async function discoverBoard(boardId: string | number): Promise<{
  board: BoardStructure;
  subitemBoard?: BoardStructure;
}> {
  const board = await getBoardStructure(boardId);
  if (!board.subitemBoardId) return { board };
  const subitemBoard = await getBoardStructure(board.subitemBoardId);
  return { board, subitemBoard };
}

const GROUP_SUBITEMS_QUERY = `
  query ($boardId: [ID!]) {
    boards(ids: $boardId) {
      groups {
        id
        title
        items_page(limit: 50) { items { name subitems { name } } }
      }
    }
  }
`;

/**
 * Distinct subitem names available in a group — the options for a
 * `subitem_checked` rule. Subitems differ per item, but within a group they
 * share names (cloned from the template), so rules match by name.
 *
 * Primary source: the names actually present on items in the group. Fallback
 * (e.g. an empty group): the matching template item in the Templates group.
 */
export async function getGroupSubitemNames(
  boardId: string | number,
  groupId: string,
  templatesGroupTitle = 'Templates',
): Promise<string[]> {
  const data = await mondayGraphql<{ boards: { groups: any[] }[] }>(GROUP_SUBITEMS_QUERY, {
    boardId: [String(boardId)],
  });
  const groups = data.boards?.[0]?.groups ?? [];
  const target = groups.find((g) => g.id === groupId);
  if (!target) return [];

  const collect = (group: any): string[] =>
    (group?.items_page?.items ?? []).flatMap((i: any) => (i.subitems ?? []).map((s: any) => s.name));

  const fromGroup = [...new Set(collect(target).filter(Boolean))].sort();
  if (fromGroup.length) return fromGroup;

  // Fallback: template item whose name is contained in this group's title.
  const templates = groups.find((g) => String(g.title ?? '').toLowerCase() === templatesGroupTitle.toLowerCase());
  const title = String(target.title ?? '').toLowerCase();
  const templateItem = (templates?.items_page?.items ?? []).find((it: any) =>
    it.name && title.includes(String(it.name).toLowerCase()),
  );
  return [...new Set(((templateItem?.subitems ?? []) as any[]).map((s) => s.name).filter(Boolean))].sort();
}
