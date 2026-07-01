import { mondayGraphql } from './client.js';
import { log } from '../util/logger.js';
import type { ItemContext } from './hydrate.js';

/**
 * Template-subitem cloner — TS port of the former WordPress plugin
 * (`monday-subitem-cloner.php`, now retired). When an item enters a group, it finds the
 * template item in the Templates group whose name is contained in the group
 * title, and clones that template's subitems onto the item (once).
 *
 * Pure matching/skip logic is exported for testing; monday calls are injectable.
 */

export interface CloneOptions {
  templatesGroupTitle: string;
  templateSourceColumnId: string;
}

export interface CloneResult {
  action: 'created' | 'skipped' | 'ignored';
  reason?: string;
  templateName?: string;
  created?: number;
}

const SKIP_COLUMN_IDS = new Set(['name', 'subitems']);
const SKIP_COLUMN_TYPES = new Set([
  'mirror',
  'formula',
  'creation_log',
  'last_updated',
  'auto_number',
  'board_relation',
  'dependency',
]);

interface TemplateItem {
  id: string;
  name: string;
}

/** First template whose name appears in the group title (case-insensitive). */
export function matchTemplateByGroupTitle<T extends { name: string }>(
  groupTitle: string,
  templates: T[],
): T | null {
  const title = groupTitle.toLowerCase();
  for (const t of templates) {
    const name = t.name?.trim();
    if (name && title.includes(name.toLowerCase())) return t;
  }
  return null;
}

/** Has this item already had `templateName` applied (via the source column)? */
export function templateAlreadyApplied(
  item: ItemContext,
  templateSourceColumnId: string,
  templateName: string,
): boolean {
  return item.subitems.some(
    (s) => (s.columns[templateSourceColumnId]?.text ?? '').toLowerCase() === templateName.toLowerCase(),
  );
}

/** Build column_values for a cloned subitem, skipping non-portable columns. */
export function prepareSubitemColumnValues(
  columnValues: { id: string; type: string; value: string | null }[],
  templateSourceColumnId: string,
  templateName: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columnValues) {
    if (!col.id || SKIP_COLUMN_IDS.has(col.id) || SKIP_COLUMN_TYPES.has(col.type)) continue;
    if (col.id === templateSourceColumnId) continue; // forced below
    if (typeof col.value === 'string' && col.value !== '') {
      try {
        out[col.id] = JSON.parse(col.value);
      } catch {
        out[col.id] = col.value;
      }
    }
  }
  out[templateSourceColumnId] = templateName;
  return out;
}

// ── monday calls ─────────────────────────────────────────────────────────────

async function getTemplateItems(boardId: number, templatesGroupTitle: string): Promise<TemplateItem[]> {
  const query = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        groups { id title items_page(limit: 500) { items { id name } } }
      }
    }
  `;
  const data = await mondayGraphql<{ boards: { groups: any[] }[] }>(query, { boardId: [String(boardId)] });
  const groups = data.boards?.[0]?.groups ?? [];
  for (const g of groups) {
    if (String(g.title ?? '').trim().toLowerCase() === templatesGroupTitle.toLowerCase()) {
      return g.items_page?.items ?? [];
    }
  }
  return [];
}

async function getTemplateSubitems(
  templateItemId: string,
): Promise<{ name: string; column_values: { id: string; type: string; value: string | null }[] }[]> {
  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        subitems { name column_values { id type value } }
      }
    }
  `;
  const data = await mondayGraphql<{ items: any[] }>(query, { itemId: [String(templateItemId)] });
  return data.items?.[0]?.subitems ?? [];
}

async function createSubitem(parentItemId: number, name: string, columnValues: Record<string, unknown>) {
  const mutation = `
    mutation ($parentItemId: ID!, $itemName: String!, $columnValues: JSON) {
      create_subitem(parent_item_id: $parentItemId, item_name: $itemName, column_values: $columnValues) {
        id name
      }
    }
  `;
  return mondayGraphql(mutation, {
    parentItemId: String(parentItemId),
    itemName: name,
    columnValues: Object.keys(columnValues).length ? JSON.stringify(columnValues) : null,
  });
}

/** Signature the engine depends on (so it can be mocked in tests). */
export type Cloner = (item: ItemContext, opts: CloneOptions) => Promise<CloneResult>;

export const cloneTemplateSubitems: Cloner = async (item, opts) => {
  if (item.groupTitle.trim().toLowerCase() === opts.templatesGroupTitle.toLowerCase()) {
    return { action: 'ignored', reason: 'item is in Templates group' };
  }

  const templates = await getTemplateItems(item.boardId, opts.templatesGroupTitle);
  const matched = matchTemplateByGroupTitle(item.groupTitle, templates);
  if (!matched) return { action: 'ignored', reason: 'no matching template' };

  if (templateAlreadyApplied(item, opts.templateSourceColumnId, matched.name)) {
    return { action: 'skipped', reason: 'template already applied', templateName: matched.name };
  }

  const subitems = await getTemplateSubitems(matched.id);
  if (subitems.length === 0) {
    return { action: 'skipped', reason: 'template has no subitems', templateName: matched.name };
  }

  let created = 0;
  for (const sub of subitems) {
    const columnValues = prepareSubitemColumnValues(
      sub.column_values ?? [],
      opts.templateSourceColumnId,
      matched.name,
    );
    try {
      await createSubitem(item.id, sub.name || 'Copied subitem', columnValues);
      created++;
    } catch (err) {
      log.error(`clone: failed to create subitem "${sub.name}"`, err);
    }
  }
  return { action: 'created', templateName: matched.name, created };
};
