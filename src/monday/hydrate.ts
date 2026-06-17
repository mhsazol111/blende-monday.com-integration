import { mondayGraphql } from './client.js';

/**
 * Hydrated view of an item, built from the monday API. Webhook payloads are
 * sparse, so the rules engine reads the live item to evaluate conditions and
 * fill templates.
 */
export interface ColumnSnapshot {
  text: string;
  value: string | null;
  type: string;
}

export interface SubitemSnapshot {
  id: number;
  /** Subitem board id — needed to write back to a subitem column. */
  boardId: number;
  name: string;
  columns: Record<string, ColumnSnapshot>;
}

export interface ItemContext {
  id: number;
  boardId: number;
  name: string;
  groupId: string;
  groupTitle: string;
  columns: Record<string, ColumnSnapshot>;
  subitems: SubitemSnapshot[];
  /** Resolved email addresses per people-column id (for `toFromColumn`). */
  people: Record<string, string[]>;
}

/** Anything that can turn an itemId into an ItemContext (real or mocked). */
export type Hydrator = (itemId: number) => Promise<ItemContext | null>;

const ITEM_QUERY = `
  query ($itemId: [ID!]) {
    items(ids: $itemId) {
      id
      name
      board { id }
      group { id title }
      column_values { id text value type }
      subitems {
        id
        name
        board { id }
        column_values { id text value type }
      }
    }
  }
`;

function indexColumns(cols: any[]): Record<string, ColumnSnapshot> {
  const out: Record<string, ColumnSnapshot> = {};
  for (const c of cols ?? []) {
    out[c.id] = { text: c.text ?? '', value: c.value ?? null, type: c.type ?? '' };
  }
  return out;
}

const USERS_QUERY = `
  query ($ids: [ID!]) {
    users(ids: $ids) { id email }
  }
`;

/** Extract `person` ids from a people column's raw value JSON. */
function personIdsFromValue(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const pat = parsed?.personsAndTeams;
    if (!Array.isArray(pat)) return [];
    return pat.filter((p: any) => p?.kind === 'person' && p?.id != null).map((p: any) => Number(p.id));
  } catch {
    return [];
  }
}

/** Resolve people-column person ids to emails (one batched users() call). */
async function resolvePeople(
  columns: { id: string; value: string | null }[],
): Promise<Record<string, string[]>> {
  const idsByCol: Record<string, number[]> = {};
  const all = new Set<number>();
  for (const c of columns) {
    const ids = personIdsFromValue(c.value);
    if (ids.length) {
      idsByCol[c.id] = ids;
      ids.forEach((id) => all.add(id));
    }
  }
  if (all.size === 0) return {};

  const data = await mondayGraphql<{ users: { id: string; email: string }[] }>(USERS_QUERY, {
    ids: [...all].map(String),
  });
  const emailById = new Map<number, string>();
  for (const u of data.users ?? []) if (u.email) emailById.set(Number(u.id), u.email);

  const out: Record<string, string[]> = {};
  for (const [colId, ids] of Object.entries(idsByCol)) {
    out[colId] = ids.map((id) => emailById.get(id)).filter((e): e is string => !!e);
  }
  return out;
}

export const hydrateItem: Hydrator = async (itemId) => {
  const data = await mondayGraphql<{ items: any[] }>(ITEM_QUERY, { itemId: [String(itemId)] });
  const item = data.items?.[0];
  if (!item) return null;

  const rawColumns = (item.column_values ?? []) as { id: string; value: string | null }[];
  const people = await resolvePeople(rawColumns);

  return {
    id: Number(item.id),
    boardId: Number(item.board?.id ?? 0),
    name: item.name ?? '',
    groupId: item.group?.id ?? '',
    groupTitle: item.group?.title ?? '',
    columns: indexColumns(item.column_values),
    subitems: (item.subitems ?? []).map((s: any) => ({
      id: Number(s.id),
      boardId: Number(s.board?.id ?? 0),
      name: s.name ?? '',
      columns: indexColumns(s.column_values),
    })),
    people,
  };
};
