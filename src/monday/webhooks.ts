import { mondayGraphql } from './client.js';

/**
 * monday webhook registration (the "Connect a board" action).
 *
 * Webhooks are decoupled from rule logic: a webhook only tells us "something
 * changed on this board". The rules engine decides what to do. So you register
 * the full event set ONCE per board and never touch it again when you change
 * triggers/conditions/actions — you only re-register if the public URL changes
 * or you introduce a brand-new monday event type.
 *
 * This module lists/creates/deletes webhooks via the monday API and offers an
 * idempotent `reconcileWebhooks` that both the configurator UI and the CLI use.
 */

/**
 * The complete set of monday events this service needs to drive every trigger.
 * Registering all of them up front means future triggers just reinterpret
 * events we already receive — no re-registration required.
 *
 *  - create_item               → item created            (item_entered_group)
 *  - item_moved_to_any_group   → item moved between groups(item_entered_group / item_left_group)
 *  - change_column_value       → any column changed      (status_changed_to + column_* conditions)
 *  - change_subitem_column_value → a subitem column changed (subitem_checked / all_subitems_checked)
 *  - move_item_to_board        → item moved to another board/workspace (item_moved)
 *
 * IMPORTANT: these are monday's **WebhookEventType registration** names, which
 * differ from the payload `type` strings the normalizer reads (e.g. you register
 * `create_item` but the payload arrives as `create_pulse`; `item_moved_to_any_group`
 * arrives as `move_pulse_into_group`). Don't "align" these with the normalizer.
 *
 * Note: `change_column_value` is the catch-all that also covers status columns;
 * we deliberately do NOT also register `change_status_column_value` to avoid
 * two webhooks firing for one status change (they'd carry different trigger
 * UUIDs, so the engine's resend-dedupe couldn't collapse them → double sends).
 * The `item_in_group_for_days` trigger needs no webhook — it's armed at group
 * entry and fired by the worker.
 */
export const WEBHOOK_EVENTS = [
  'create_item',
  'item_moved_to_any_group',
  'change_column_value',
  'change_subitem_column_value',
  'move_item_to_board',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface MondayWebhook {
  id: string;
  event: string;
  boardId: string;
  /** monday's per-webhook config JSON (e.g. columnId for specific-column hooks). */
  config?: string | null;
}

const LIST_QUERY = `
  query ($boardId: ID!) {
    webhooks(board_id: $boardId) { id event board_id config }
  }
`;

const CREATE_MUTATION = `
  mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!) {
    create_webhook(board_id: $boardId, url: $url, event: $event) { id event board_id }
  }
`;

const DELETE_MUTATION = `
  mutation ($id: ID!) {
    delete_webhook(id: $id) { id board_id }
  }
`;

/** Every webhook currently registered on a board. */
export async function listWebhooks(boardId: string | number): Promise<MondayWebhook[]> {
  const data = await mondayGraphql<{ webhooks: any[] }>(LIST_QUERY, { boardId: String(boardId) });
  return (data.webhooks ?? []).map((w) => ({
    id: String(w.id),
    event: String(w.event),
    boardId: String(w.board_id),
    config: w.config ?? null,
  }));
}

/** Create one webhook for `event` on `boardId` pointing at `url`. */
export async function createWebhook(
  boardId: string | number,
  url: string,
  event: WebhookEvent,
): Promise<MondayWebhook> {
  const data = await mondayGraphql<{ create_webhook: any }>(CREATE_MUTATION, {
    boardId: String(boardId),
    url,
    event,
  });
  const w = data.create_webhook;
  return { id: String(w.id), event: String(w.event), boardId: String(w.board_id) };
}

/** Delete a webhook by id. Returns the deleted id. */
export async function deleteWebhook(id: string | number): Promise<string> {
  const data = await mondayGraphql<{ delete_webhook: any }>(DELETE_MUTATION, { id: String(id) });
  return String(data.delete_webhook?.id ?? id);
}

export interface ReconcileResult {
  boardId: string;
  url: string;
  /** Webhooks created in this run. */
  created: MondayWebhook[];
  /** Stale webhooks for our managed events that were removed first. */
  removed: string[];
  /** Events that could not be registered (e.g. unsupported by this account). */
  failed: { event: WebhookEvent; error: string }[];
}

/**
 * Idempotently make `boardId` have exactly one webhook per managed event, all
 * pointing at `url`. Clicking "Connect" twice yields the same end state.
 *
 * The monday API does not return a webhook's target URL, so we can't tell
 * whether an existing hook already points at the right place. We therefore
 * reconcile by event: delete any existing webhooks whose event we manage, then
 * recreate them at the current URL. Webhooks for events we don't manage are
 * left untouched.
 *
 * Each create is independent: if one event isn't supported by the account it's
 * recorded in `failed` and the rest still register — so one odd event can't
 * block connecting the board.
 */
export async function reconcileWebhooks(
  boardId: string | number,
  url: string,
): Promise<ReconcileResult> {
  const managed = new Set<string>(WEBHOOK_EVENTS);
  const existing = await listWebhooks(boardId);

  const removed: string[] = [];
  for (const w of existing) {
    if (managed.has(w.event)) {
      await deleteWebhook(w.id);
      removed.push(w.id);
    }
  }

  const created: MondayWebhook[] = [];
  const failed: { event: WebhookEvent; error: string }[] = [];
  for (const event of WEBHOOK_EVENTS) {
    try {
      created.push(await createWebhook(boardId, url, event));
    } catch (err: any) {
      failed.push({ event, error: err?.message ?? 'create failed' });
    }
  }

  return { boardId: String(boardId), url, created, removed, failed };
}

/**
 * Build the URL monday should POST to: `<base>/webhook` plus the shared secret
 * (the ingress requires it). `base` should be the public HTTPS origin.
 */
export function buildWebhookUrl(base: string, secret?: string): string {
  const origin = base.replace(/\/+$/, '');
  return secret ? `${origin}/webhook?secret=${encodeURIComponent(secret)}` : `${origin}/webhook`;
}
