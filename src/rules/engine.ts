import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { renderTemplate } from '../util/template.js';
import { htmlToText, htmlToSlack, looksLikeHtml } from '../util/html.js';
import type { NormalizedEvent } from '../events/types.js';
import { hydrateItem, type Hydrator, type ItemContext, type SubitemSnapshot } from '../monday/hydrate.js';
import { defaultSenders, type Senders } from '../senders/index.js';
import { cloneTemplateSubitems, type Cloner } from '../monday/clone.js';
import {
  setColumnValue,
  postItemUpdate,
  moveItemToGroup,
  type ColumnWriter,
  type UpdateWriter,
  type GroupMover,
} from '../monday/write.js';
import type { EngineStore, QueuedActionRow, QueuedActionType, RenderHints } from '../queue/types.js';
import type { Action, ActionWhen, Condition, EmailAction, Rule, Trigger } from './types.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/**
 * Rules engine (Phases 3–4).
 *
 * Instant path: match trigger + scope, hydrate the item, evaluate AND
 * conditions, run immediate email/slack actions.
 *
 * Scheduled path (needs a store): relative/absolute actions are enqueued;
 * the `item_in_group_for_days` trigger is armed at group entry; `clear_pending`
 * and auto-clear-on-leave/re-entry cancel pending actions for the item.
 *
 * Deps are injected so the engine is testable without monday/DB/network.
 */
export interface EngineDeps {
  rules: Rule[];
  hydrate?: Hydrator;
  senders?: Senders;
  store?: EngineStore;
  cloner?: Cloner;
  columnWriter?: ColumnWriter;
  updateWriter?: UpdateWriter;
  groupMover?: GroupMover;
  /** Patient contact-consent gate. Defaults to the CONTACT_OPTOUT_* env vars;
   *  injectable so tests can configure it (env is read at module load). */
  contactOptOut?: ContactOptOutConfig;
}

/** Notification channels the consent gate can suppress. */
export type ContactChannel = 'email' | 'slack';

export interface ContactOptOutConfig {
  /** Board column holding the flag. Empty string disables the gate. */
  columnId: string;
  /** The one value that suppresses contact (compared trimmed + case-insensitively). */
  blockValue: string;
  /** Channels the gate applies to. Empty ⇒ the gate never suppresses anything. */
  channels: ContactChannel[];
}

export interface HandleResult {
  matched: number;
  executed: number;
  scheduled: number;
  cleared: number;
  deferred: number;
  /** Deliberately not delivered (e.g. the item is opted out of email). */
  suppressed: number;
  /** Actions that threw (isolated so they don't abort the rest). */
  failed: number;
}

type ActionOutcome = 'executed' | 'scheduled' | 'cleared' | 'deferred' | 'skipped' | 'suppressed';

/**
 * Outcome of a single `dispatch`. A suppressed send is NOT an error — the caller
 * should record it as terminal (never retried) but report it distinctly, so a
 * silently-withheld notification is never presented to the user as a successful send.
 */
export interface DispatchResult {
  suppressed?: { reason: 'contact_opt_out'; channel: ContactChannel; detail: string };
}

/** Which item a dispatched payload belongs to (drives the email opt-out gate). */
export interface DispatchContext {
  itemId?: number;
  /** Already-hydrated context, when the caller has one (avoids a monday round-trip). */
  item?: ItemContext;
}

export class RulesEngine {
  private rules: Rule[];
  private readonly hydrate: Hydrator;
  private readonly senders: Senders;
  private readonly store?: EngineStore;
  private readonly cloner: Cloner;
  private readonly columnWriter: ColumnWriter;
  private readonly updateWriter: UpdateWriter;
  private readonly groupMover: GroupMover;
  private readonly contactOptOut: ContactOptOutConfig;

  constructor(deps: EngineDeps) {
    this.rules = deps.rules;
    this.hydrate = deps.hydrate ?? hydrateItem;
    this.senders = deps.senders ?? defaultSenders;
    this.store = deps.store;
    this.cloner = deps.cloner ?? cloneTemplateSubitems;
    this.columnWriter = deps.columnWriter ?? setColumnValue;
    this.updateWriter = deps.updateWriter ?? postItemUpdate;
    this.groupMover = deps.groupMover ?? moveItemToGroup;
    this.contactOptOut = deps.contactOptOut ?? {
      columnId: env.contactOptOutColumnId,
      blockValue: env.contactOptOutBlockValue,
      channels: env.contactOptOutChannels,
    };
  }

  /** Replace the active ruleset (used by the configurator after a save). */
  setRules(rules: Rule[]): void {
    this.rules = rules;
  }

  async handleEvent(event: NormalizedEvent): Promise<HandleResult> {
    const result: HandleResult = { matched: 0, executed: 0, scheduled: 0, cleared: 0, deferred: 0, suppressed: 0, failed: 0 };

    const itemId = itemIdToHydrate(event);
    if (itemId === undefined) return result;

    // Auto-clear pending actions when an item leaves a group.
    if (this.store && event.kind === 'item_left_group') {
      result.cleared += this.store.cancelPendingForItem(itemId);
      this.store.clearItemEntry(itemId);
    }

    // Subitem events arrive with the SUBITEM board's id, but rules target the
    // parent board — so don't board-filter subitem events here; the parent
    // board is checked after hydration (rule.boardId === item.boardId).
    const candidates = this.rules.filter(
      (r) =>
        r.enabled &&
        triggerKindMatches(r.trigger, event) &&
        (event.kind === 'subitem_changed' || r.boardId === event.boardId),
    );
    const needHydrate = candidates.length > 0 || (!!this.store && event.kind === 'item_entered_group');
    if (!needHydrate) return result;

    const hydrated = await this.hydrate(itemId);
    if (!hydrated) {
      log.warn(`Could not hydrate item ${itemId} for event ${event.kind}.`);
      return result;
    }
    // Re-pointed when a clone creates subitems, so every LATER rule sees them too
    // (see the rule loop). Without that, two rules cloning on the same event both
    // read a pre-clone snapshot and the second one's "already applied" dedupe
    // misses → duplicate subitems.
    let item = hydrated;

    // Moving between groups counts as leaving the old one → clear its pending
    // actions BEFORE the rule loop enqueues the NEW group's scheduled actions.
    // (Doing this in onEnteredGroup, after the loop, cancelled the action we'd
    // just enqueued for the destination group.)
    if (this.store && event.kind === 'item_entered_group') {
      const prev = this.store.getItemEntry(itemId);
      if (prev && prev.groupId !== item.groupId) {
        result.cleared += this.store.cancelPendingForItem(itemId);
      }
    }

    // Event-only context, kept alongside any queued action so a send-time
    // re-render can reproduce {{status}} / {{subitem.*}} from a fresh item.
    const hints = hintsFromEvent(event);

    // Extra signals some conditions need beyond the hydrated item (e.g. the
    // source group on a move, which only the event carries).
    const evalCtx: ConditionContext = {
      fromGroupId: event.kind === 'item_entered_group' ? event.fromGroupId : undefined,
    };

    // Instant rule matching.
    for (const rule of candidates) {
      if (rule.boardId !== item.boardId) continue; // parent board for subitem events
      if (!ruleScopeMatches(rule, item, event)) continue;
      if (!triggerDetailsMatch(rule.trigger, event)) continue;
      if (rule.trigger.type === 'all_subitems_checked' && !allSubitemsAtLabel(item, rule.trigger)) continue;
      if (rule.trigger.type === 'item_column_changed' && !itemColumnMatches(item, rule.trigger)) continue;
      if (!conditionsPass(rule, item, evalCtx)) continue;

      result.matched++;
      // Per-rule working copy: a clone action that creates subitems refreshes
      // this so later actions (e.g. set_column on a just-cloned subitem) see them.
      let curItem = item;
      let ctx = buildContext(curItem, event);
      for (const action of rule.actions) {
        // Isolate actions: one failing action (e.g. a bad Slack webhook) must not
        // abort the rest of the rule's actions or other matched rules.
        try {
          const outcome = await this.runAction(rule, curItem, action, ctx, hints);
          bump(result, outcome);
          // Re-hydrate after a clone that created subitems so subsequent actions
          // in this rule operate on the fresh subitem list (fixes clone→set_column
          // in one rule, where the original snapshot predates the new subitems).
          // Also re-point the shared `item`, so a later rule that clones sees the
          // new subitems and correctly skips instead of cloning a second set.
          if (action.type === 'clone_template_subitems' && outcome === 'executed') {
            const fresh = await this.hydrate(curItem.id);
            if (fresh) { curItem = fresh; item = fresh; ctx = buildContext(curItem, event); }
          }
        } catch (err) {
          result.failed++;
          log.error(`[rule ${rule.id}] action "${action.type}" failed`, err);
        }
      }
    }

    // Group-entry side effects: arm timed rules, track state, reset on re-entry.
    if (this.store && event.kind === 'item_entered_group') {
      this.onEnteredGroup(event, item, result);
    }

    return result;
  }

  private async runAction(
    rule: Rule,
    item: ItemContext,
    action: Action,
    ctx: Record<string, unknown>,
    hints: RenderHints,
  ): Promise<ActionOutcome> {
    if (action.type === 'clear_pending') {
      if (!this.store) {
        log.info(`[rule ${rule.id}] clear_pending requires a store; skipped.`);
        return 'deferred';
      }
      let ruleIds: string[] | undefined;
      if (action.scope === 'rules') {
        ruleIds = action.ruleIds ?? [];
        if (ruleIds.length === 0) {
          log.warn(`[rule ${rule.id}] clear_pending scope=rules but no ruleIds; nothing cleared.`);
          return 'cleared';
        }
      }
      const n = this.store.cancelPendingForItem(item.id, ruleIds);
      const target = ruleIds ? `rules [${ruleIds.join(', ')}]` : 'all rules';
      log.info(`[rule ${rule.id}] clear_pending cancelled ${n} action(s) for item ${item.id} (${target}).`);
      return 'cleared';
    }

    if (action.type === 'clone_template_subitems') {
      const res = await this.cloner(item, {
        templatesGroupTitle: action.templatesGroupTitle,
        templateSourceColumnId: action.templateSourceColumnId,
      });
      const extra = res.created != null ? ` created=${res.created}` : '';
      log.info(`[rule ${rule.id}] clone: ${res.action}${res.reason ? ` (${res.reason})` : ''}${extra}.`);
      return res.action === 'created' ? 'executed' : 'skipped';
    }

    // set_column/post_update targeting a subitem: make sure the named subitem
    // exists before scheduling/sending, so we never enqueue an unwritable action.
    if ((action.type === 'set_column' || action.type === 'post_update') && action.target === 'subitem') {
      if (!findSubitemByName(item, action.subitemName)) {
        log.warn(`[rule ${rule.id}] ${action.type}: subitem "${action.subitemName}" not found on item ${item.id}; skipped.`);
        return 'skipped';
      }
    }

    if (action.when.mode !== 'immediate') {
      if (!this.store) {
        log.info(`[rule ${rule.id}] ${action.type} scheduled but no store; deferred.`);
        return 'deferred';
      }
      const { actionType, payload } = renderAction(action, ctx, item);
      const dueAt = dueAtFor(action.when, item);
      // `render` lets the worker re-render this against fresh data at send time;
      // `payload` (rendered now) is the fallback if that can't run.
      this.store.enqueue({ itemId: item.id, ruleId: rule.id, actionType, payload, dueAt, render: { action, hints } });
      log.info(`[rule ${rule.id}] ${action.type} scheduled for ${new Date(dueAt).toISOString()}.`);
      return 'scheduled';
    }

    const res = await this.dispatch(action.type, renderAction(action, ctx, item).payload, { item });
    return res.suppressed ? 'suppressed' : 'executed';
  }

  /**
   * Global patient contact-consent gate.
   *
   * Returns 'allow' | 'block' for one channel; THROWS if the flag can't be read (fail
   * closed) so the caller's retry/error handling sees it rather than silently
   * contacting an item whose consent state is unknown. An absent or empty column value
   * means allowed — the board manager only ever has to mark the exceptions.
   */
  private async contactOptOutState(channel: ContactChannel, ctx?: DispatchContext): Promise<'allow' | 'block'> {
    const { columnId, blockValue, channels } = this.contactOptOut;
    if (!columnId) return 'allow'; // gate not configured
    if (!channels.includes(channel)) return 'allow'; // channel not gated

    let item = ctx?.item;
    if (!item) {
      if (ctx?.itemId === undefined) {
        throw new Error(
          `Contact opt-out gate: no item context for this ${channel} send (column "${columnId}" configured); refusing to send.`,
        );
      }
      const hydrated = await this.hydrate(ctx.itemId); // may throw — intentionally propagates
      if (!hydrated) {
        throw new Error(`Contact opt-out gate: could not hydrate item ${ctx.itemId}; refusing to send.`);
      }
      item = hydrated;
    }

    const col = item.columns[columnId];
    if (col === undefined) {
      // Misconfigured id (typo/deleted column) — allow, but say so loudly. The
      // alternative silently blocks ALL notifications, which is far harder to notice.
      log.warn(
        `Contact opt-out gate: column "${columnId}" not found on item ${item.id}; ` +
          `treating as allowed. Check CONTACT_OPTOUT_COLUMN_ID.`,
      );
      return 'allow';
    }

    const value = (col.text ?? '').trim().toLowerCase();
    return value === blockValue.trim().toLowerCase() ? 'block' : 'allow';
  }

  /**
   * Send a rendered payload now (also used by the worker for due actions and by the
   * configurator's "run now"). `ctx` carries the item this payload belongs to so the
   * contact opt-out gate can read its live consent flag at send time; pass the already
   * hydrated `item` when you have one to avoid a redundant monday call.
   */
  async dispatch(actionType: QueuedActionType, payload: unknown, ctx?: DispatchContext): Promise<DispatchResult> {
    if (actionType === 'email') {
      const p = payload as { to: string[]; subject: string; body: string; html?: string };
      if ((await this.contactOptOutState('email', ctx)) === 'block') {
        const detail = this.optOutDetail('email', ctx);
        log.warn(`[email] suppressed — ${detail} (subject="${p.subject}")`);
        return { suppressed: { reason: 'contact_opt_out', channel: 'email', detail } };
      }
      await this.senders.sendEmail(p);
    } else if (actionType === 'set_column') {
      const p = payload as { boardId: number; itemId: number; columnId: string; value: string };
      await this.columnWriter(p);
    } else if (actionType === 'post_update') {
      const p = payload as { itemId: number; body: string };
      await this.updateWriter(p);
    } else if (actionType === 'move_item_to_group') {
      const p = payload as { boardId: number; itemId: number; group: string };
      // The mover resolves the destination (id or title) and skips a move to the
      // group the item is already in — both at send time, never on a snapshot.
      const res = await this.groupMover(p);
      log.info(
        res.moved
          ? `[move] item ${p.itemId} → ${res.groupTitle} (${res.groupId}).`
          : `[move] item ${p.itemId} not moved — ${res.reason}.`,
      );
    } else {
      const p = payload as { webhookUrl: string; text: string };
      // Slack is gated too: a Slack post about a patient is still a notification
      // about someone who asked not to be contacted. Drop 'slack' from
      // CONTACT_OPTOUT_CHANNELS if internal pings should keep flowing.
      if ((await this.contactOptOutState('slack', ctx)) === 'block') {
        const detail = this.optOutDetail('slack', ctx);
        log.warn(`[slack] suppressed — ${detail}`);
        return { suppressed: { reason: 'contact_opt_out', channel: 'slack', detail } };
      }
      await this.senders.sendSlack(p);
    }
    return {};
  }

  /** Human-readable "why nothing was sent", shown in the queue and the admin UI. */
  private optOutDetail(channel: ContactChannel, ctx?: DispatchContext): string {
    const who = ctx?.item?.id ?? ctx?.itemId;
    const what = channel === 'email' ? 'email' : 'Slack notification';
    return (
      `Item ${who} is marked “${this.contactOptOut.blockValue}” on the contact opt-out ` +
      `column (${this.contactOptOut.columnId}) — ${what} withheld.`
    );
  }

  /**
   * Fire-time gate for a queued action (called by the worker before dispatch).
   * Only `item_in_group_for_days` rules with conditions are re-evaluated: the item
   * is re-hydrated and the rule's conditions re-checked, so a timed reminder
   * self-cancels once the state that justified it changes (e.g. the plan is signed).
   * Anything else — missing/non-timed rule, no conditions, un-hydratable item — fires
   * (we never silently drop a send we can't disprove).
   */
  async shouldFireQueued(ruleId: string, itemId: number): Promise<boolean> {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!this.needsConditionRecheck(rule)) return true;
    try {
      const item = await this.hydrate(itemId);
      if (!item) return true;
      return conditionsPass(rule!, item, {});
    } catch (err) {
      log.warn(`shouldFireQueued: could not re-check rule ${ruleId} for item ${itemId}; firing.`, err);
      return true;
    }
  }

  /** Only timed rules that actually have conditions are re-evaluated at fire time. */
  private needsConditionRecheck(rule: Rule | undefined): boolean {
    if (!rule || rule.trigger.type !== 'item_in_group_for_days') return false;
    return !!(rule.conditionGroups?.length || rule.conditions?.length);
  }

  /**
   * Prepare a due action for sending: re-check the fire-time condition gate AND
   * re-render the payload against a freshly hydrated item.
   *
   * Re-rendering matters because a queued action's text was rendered when the rule
   * armed — up to weeks earlier for `item_in_group_for_days`. Without this, a
   * "what's still outstanding" message lists work that has since been completed.
   *
   * Fails safe at every step: no envelope (rows queued before this shipped), an
   * un-hydratable item, or a render error all fall back to the payload as armed —
   * a send is never silently dropped or blanked. Only the condition gate returns
   * `fire: false`, and only for timed rules (see `needsConditionRecheck`).
   */
  async prepareQueued(
    row: Pick<QueuedActionRow, 'ruleId' | 'itemId' | 'actionType' | 'payload' | 'render'>,
    opts: { recheckConditions?: boolean } = {},
  ): Promise<{ fire: boolean; payload: unknown }> {
    const asArmed = { fire: true, payload: row.payload };
    const rule = this.rules.find((r) => r.id === row.ruleId);
    const gate = (opts.recheckConditions ?? true) && this.needsConditionRecheck(rule);
    if (!gate && !row.render) return asArmed; // nothing to do — skip the monday call

    let item: ItemContext | null = null;
    try {
      item = await this.hydrate(row.itemId);
    } catch (err) {
      log.warn(`prepareQueued: could not hydrate item ${row.itemId}; sending as armed.`, err);
    }
    if (!item) return asArmed;

    if (gate && !conditionsPass(rule!, item, {})) return { fire: false, payload: row.payload };
    if (!row.render) return asArmed;

    try {
      const ctx = contextFrom(item, row.render.hints ?? {});
      const { payload } = renderAction(row.render.action, ctx, item);
      return { fire: true, payload: keepArmedRecipients(row.actionType, row.payload, payload) };
    } catch (err) {
      // e.g. the action targets a subitem that has since been deleted. Better to
      // send slightly stale text than nothing at all.
      log.warn(`prepareQueued: re-render failed for rule ${row.ruleId} / item ${row.itemId}; sending as armed.`, err);
      return asArmed;
    }
  }

  private onEnteredGroup(
    event: Extract<NormalizedEvent, { kind: 'item_entered_group' }>,
    item: ItemContext,
    result: HandleResult,
  ): void {
    const store = this.store!;
    const now = Date.now();

    // The clear-on-move happens earlier (before the rule loop) so it doesn't
    // cancel the destination group's just-enqueued actions. Here we only record
    // the new entry and arm timed rules.
    store.recordItemEntry(item.id, event.boardId, item.groupId, now);

    // Arm `item_in_group_for_days` rules whose scope matches this group.
    for (const rule of this.rules) {
      if (!rule.enabled || rule.boardId !== event.boardId) continue;
      if (rule.trigger.type !== 'item_in_group_for_days') continue;
      if (!scopeMatches(rule, item)) continue;

      // The N-days mark is the base; each action's own `when` layers on top of it
      // (immediate → fire at N days; relative/relative_from_column → N days + that
      // delay; absolute → its own timestamp).
      const base = now + rule.trigger.days * DAY_MS;
      const hints = hintsFromEvent(event);
      const ctx = buildContext(item, event);
      rule.actions.forEach((action, idx) => {
        if (action.type === 'clear_pending' || action.type === 'clone_template_subitems') return;
        if (action.type === 'set_column' && action.target === 'subitem' && !findSubitemByName(item, action.subitemName)) {
          log.warn(`[rule ${rule.id}] timed set_column: subitem "${action.subitemName}" not found; skipped.`);
          return;
        }
        const { actionType, payload } = renderAction(action, ctx, item);
        store.enqueue({
          itemId: item.id,
          ruleId: rule.id,
          actionType,
          payload,
          dueAt: dueAtFor(action.when, item, base),
          dedupeKey: `timed:${rule.id}:${item.id}:${now}:${idx}`,
          // Timed rules wait days or weeks — re-rendering at send time is what
          // keeps "what's still outstanding" lists honest.
          render: { action, hints },
        });
        result.scheduled++;
      });
      log.info(`[rule ${rule.id}] armed for item ${item.id}, base due ${new Date(base).toISOString()}.`);
    }
  }
}

// ── timing / rendering ──────────────────────────────────────────────────────

/**
 * Compute when an action is due. `base` is the reference time the delay is added
 * to (defaults to now; the timed `item_in_group_for_days` path passes the N-days
 * mark so an action's `when` layers on top). `absolute` ignores `base`.
 */
function dueAtFor(when: ActionWhen, item: ItemContext, base: number = Date.now()): number {
  if (when.mode === 'relative') {
    return base + (when.days ?? 0) * DAY_MS + (when.hours ?? 0) * HOUR_MS + (when.minutes ?? 0) * MIN_MS;
  }
  if (when.mode === 'absolute') {
    const t = Date.parse(when.at);
    if (Number.isNaN(t)) {
      log.warn(`Invalid absolute time "${when.at}"; sending immediately.`);
      return base;
    }
    return t;
  }
  if (when.mode === 'relative_from_column') {
    const source =
      when.target === 'subitem'
        ? findSubitemByName(item, when.subitemName)?.columns[when.columnId]?.text
        : item.columns[when.columnId]?.text;
    const n = Number.parseFloat(String(source ?? '').trim());
    if (!Number.isFinite(n)) {
      log.warn(`relative_from_column: column "${when.columnId}" value "${source ?? ''}" is not a number; sending immediately.`);
      return base;
    }
    const unitMs = when.unit === 'days' ? DAY_MS : when.unit === 'hours' ? HOUR_MS : MIN_MS;
    return base + n * unitMs;
  }
  return base;
}

function renderAction(
  action: Action,
  ctx: Record<string, unknown>,
  item: ItemContext,
): { actionType: QueuedActionType; payload: unknown } {
  if (action.type === 'email') {
    // Body may be rich HTML (configurator) or plain text (older rules). Send HTML
    // when present and always include a plain-text fallback.
    const actx = withNamedSubitem(ctx, item, action.subitemName, action.type);
    const rendered = renderTemplate(action.body, actx);
    return {
      actionType: 'email',
      payload: {
        to: mergeRecipients(action, item),
        subject: renderTemplate(action.subject, actx),
        body: htmlToText(rendered),
        ...(looksLikeHtml(rendered) ? { html: rendered } : {}),
      },
    };
  }
  if (action.type === 'slack') {
    // Slack can't render HTML — convert rich text to Slack mrkdwn.
    const actx = withNamedSubitem(ctx, item, action.subitemName, action.type);
    return {
      actionType: 'slack',
      payload: {
        webhookUrl: action.webhookUrl ?? '',
        text: htmlToSlack(renderTemplate(action.text, actx)),
      },
    };
  }
  if (action.type === 'set_column') {
    // The value may be rich HTML authored in the configurator (to stash a
    // generated message in a column for manual reuse). monday columns store
    // plain text, so flatten HTML; label-index numbers and plain values pass through.
    const rendered = renderTemplate(action.value, ctx);
    const value = looksLikeHtml(rendered) ? htmlToText(rendered) : rendered;
    if (action.target === 'subitem') {
      const sub = findSubitemByName(item, action.subitemName)!; // existence checked in runAction
      return { actionType: 'set_column', payload: { boardId: sub.boardId, itemId: sub.id, columnId: action.columnId, value } };
    }
    return { actionType: 'set_column', payload: { boardId: item.boardId, itemId: item.id, columnId: action.columnId, value } };
  }
  if (action.type === 'post_update') {
    // Post the rich HTML body verbatim — monday Updates render it and have no
    // long_text char cap (that's the point). `{{subitem.*}}` works on any trigger.
    const actx = withNamedSubitem(ctx, item, action.subitemName, action.type);
    const body = renderTemplate(action.body, actx);
    if (action.target === 'subitem') {
      const sub = findSubitemByName(item, action.subitemName)!; // existence checked in runAction
      return { actionType: 'post_update', payload: { itemId: sub.id, body } };
    }
    return { actionType: 'post_update', payload: { itemId: item.id, body } };
  }
  if (action.type === 'move_item_to_group') {
    // Render only — resolving the name to a group id happens at send time.
    return {
      actionType: 'move_item_to_group',
      payload: { boardId: item.boardId, itemId: item.id, group: renderTemplate(action.group, ctx) },
    };
  }
  throw new Error(`renderAction called with non-sendable action: ${(action as Action).type}`);
}

/**
 * When a message action names a subitem, override `{{subitem.*}}` with that
 * subitem's data so non-subitem triggers can still reference it. Returns `ctx`
 * unchanged when no name is given.
 */
function withNamedSubitem(
  ctx: Record<string, unknown>,
  item: ItemContext,
  subitemName: string | undefined,
  actionType: string,
): Record<string, unknown> {
  if (!subitemName) return ctx;
  const sub = findSubitemByName(item, subitemName);
  if (!sub) {
    log.warn(`${actionType}: subitem "${subitemName}" not found on item ${item.id}; {{subitem.*}} will be blank.`);
  }
  return { ...ctx, subitem: subitemCtx(sub, subitemName) };
}

/** Find a subitem by (case-insensitive) name on the hydrated item. */
function findSubitemByName(item: ItemContext, name?: string) {
  if (!name) return undefined;
  return item.subitems.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

/** Combine literal recipients with those resolved from the action's columns. */
function mergeRecipients(action: EmailAction, item: ItemContext): string[] {
  const ids = [...(action.toFromColumns ?? []), ...(action.toFromColumn ? [action.toFromColumn] : [])];
  const fromColumns = ids.flatMap((id) => emailsFromColumn(id, item));
  return [...new Set([...(action.to ?? []), ...fromColumns])];
}

/**
 * Resolve one column id to email addresses. People columns come from the
 * hydrated `people` map (their `.text` is a person's name, not an address);
 * every other column is parsed from its value JSON, then its text.
 */
function emailsFromColumn(columnId: string, item: ItemContext): string[] {
  const people = item.people[columnId];
  if (people?.length) return people;
  const col = item.columns[columnId];
  if (!col) {
    log.warn(`[email] recipient column "${columnId}" not found on item ${item.id}.`);
    return [];
  }
  // An email column stores {"email":"a@b.com","text":"Display Label"} — the label
  // may not be the address, so prefer the parsed `email` key over `.text`.
  if (col.value) {
    try {
      const parsed = JSON.parse(col.value);
      if (typeof parsed?.email === 'string') return extractEmails(parsed.email);
    } catch {
      /* not JSON — fall through to text */
    }
  }
  const found = extractEmails(col.text);
  if (!found.length && col.text.trim()) {
    log.warn(`[email] column "${columnId}" value "${col.text}" has no valid address.`);
  }
  return found;
}

const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

/** Split free text on commas/semicolons/whitespace and keep what looks like an address. */
function extractEmails(raw: string): string[] {
  return String(raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s));
}

function bump(result: HandleResult, outcome: ActionOutcome) {
  if (outcome === 'executed') result.executed++;
  else if (outcome === 'scheduled') result.scheduled++;
  else if (outcome === 'cleared') result.cleared++;
  else if (outcome === 'deferred') result.deferred++;
  else if (outcome === 'suppressed') result.suppressed++;
}

// ── matching helpers ────────────────────────────────────────────────────────

function itemIdToHydrate(event: NormalizedEvent): number | undefined {
  if (event.kind === 'subitem_changed') return event.parentItemId;
  if ('itemId' in event) return event.itemId;
  return undefined;
}

function triggerKindMatches(trigger: Trigger, event: NormalizedEvent): boolean {
  switch (trigger.type) {
    case 'item_entered_group':
      return event.kind === 'item_entered_group';
    case 'item_left_group':
      // monday delivers a move as ONE event (move_pulse_into_group → entered).
      // From the source group's perspective the item LEFT, so a move fires this too.
      return event.kind === 'item_left_group' || (event.kind === 'item_entered_group' && event.reason === 'moved');
    case 'status_changed_to':
      return event.kind === 'status_changed';
    case 'item_column_changed':
      // Any item column: status changes normalize to status_changed, others to column_changed.
      return event.kind === 'status_changed' || event.kind === 'column_changed';
    case 'subitem_checked':
    case 'all_subitems_checked':
      return event.kind === 'subitem_changed';
    case 'item_in_group_for_days':
      return false; // timed — armed at entry, fired by the worker.
  }
}

function triggerDetailsMatch(trigger: Trigger, event: NormalizedEvent): boolean {
  if (trigger.type === 'status_changed_to' && event.kind === 'status_changed') {
    return event.columnId === trigger.columnId && event.label === trigger.label;
  }
  if (
    trigger.type === 'item_column_changed' &&
    (event.kind === 'status_changed' || event.kind === 'column_changed')
  ) {
    // The CHANGED column must be the target one; the value (if any) is checked
    // post-hydration against the column's current text (itemColumnMatches).
    return event.columnId === trigger.columnId;
  }
  if (trigger.type === 'subitem_checked' && event.kind === 'subitem_changed') {
    if (event.columnId !== trigger.columnId || event.label !== trigger.label) return false;
    if (trigger.subitemName) {
      const name = String((event.raw as any).pulseName ?? '');
      return name.toLowerCase() === trigger.subitemName.toLowerCase();
    }
    return true;
  }
  if (trigger.type === 'all_subitems_checked' && event.kind === 'subitem_changed') {
    // Only react if the changed subitem is one of the tracked ones reaching the
    // label; the "all reached it" check happens after hydration (allSubitemsAtLabel).
    if (event.columnId !== trigger.columnId || event.label !== trigger.label) return false;
    const changed = String((event.raw as any).pulseName ?? '').toLowerCase();
    return trigger.subitemNames.some((n) => n.toLowerCase() === changed);
  }
  return true;
}

/**
 * For `item_column_changed`: with no `value`, any change to the column matches;
 * with a `value`, the column's current text must equal it (case-insensitive).
 */
function itemColumnMatches(
  item: ItemContext,
  trigger: Extract<Trigger, { type: 'item_column_changed' }>,
): boolean {
  if (!trigger.value) return true; // "any change" mode
  const text = item.columns[trigger.columnId]?.text ?? '';
  return text.trim().toLowerCase() === trigger.value.trim().toLowerCase();
}

/** True when every named subitem currently shows `label` on the parent item. */
function allSubitemsAtLabel(
  item: ItemContext,
  trigger: Extract<Trigger, { type: 'all_subitems_checked' }>,
): boolean {
  return trigger.subitemNames.every((name) =>
    item.subitems.some(
      (s) =>
        s.name.toLowerCase() === name.toLowerCase() &&
        (s.columns[trigger.columnId]?.text ?? '') === trigger.label,
    ),
  );
}

/**
 * Scope check that is trigger-aware: an `item_left_group` rule is scoped to the
 * group the item LEFT (the move's source), not the group it's now in.
 */
function ruleScopeMatches(rule: Rule, item: ItemContext, event: NormalizedEvent): boolean {
  if (rule.trigger.type === 'item_left_group') {
    const leftGroup =
      event.kind === 'item_left_group' ? event.fromGroupId
      : event.kind === 'item_entered_group' ? event.fromGroupId
      : undefined;
    // Board-wide: any group the item left counts (a move always has a source).
    if (rule.scope.allGroups) return !!leftGroup;
    return !!rule.scope.groupId && rule.scope.groupId === leftGroup;
  }
  return scopeMatches(rule, item);
}

function scopeMatches(rule: Rule, item: ItemContext): boolean {
  if (rule.scope.allGroups) return true;
  if (rule.scope.groupId) return item.groupId === rule.scope.groupId;
  if (rule.scope.groupTitleContains) {
    return item.groupTitle.toLowerCase().includes(rule.scope.groupTitleContains.toLowerCase());
  }
  return false;
}

/** Signals for condition evaluation that aren't on the hydrated item itself. */
interface ConditionContext {
  /** Source group when the triggering event was a move (monday sourceGroupId). */
  fromGroupId?: string;
}

/**
 * A rule matches when ANY of its condition groups passes (OR); within a group,
 * ALL conditions must pass (AND). Legacy flat `rule.conditions` is treated as a
 * single AND group. No groups/conditions at all → passes.
 */
function conditionsPass(rule: Rule, item: ItemContext, ctx: ConditionContext): boolean {
  const groups: Condition[][] = rule.conditionGroups?.length
    ? rule.conditionGroups.map((g) => g.conditions ?? [])
    : rule.conditions?.length
      ? [rule.conditions]
      : [];
  if (groups.length === 0) return true;
  return groups.some((conds) => conds.every((c) => conditionPass(c, item, ctx)));
}

function conditionPass(c: Condition, item: ItemContext, ctx: ConditionContext): boolean {
  switch (c.type) {
    case 'status_is':
      return (item.columns[c.columnId]?.text ?? '') === c.label;
    case 'status_is_not':
      return (item.columns[c.columnId]?.text ?? '') !== c.label;
    case 'column_equals':
      return (item.columns[c.columnId]?.text ?? '') === c.value;
    case 'column_not_equals':
      return (item.columns[c.columnId]?.text ?? '') !== c.value;
    case 'column_empty':
      return (item.columns[c.columnId]?.text ?? '') === '';
    case 'column_not_empty':
      return (item.columns[c.columnId]?.text ?? '') !== '';
    case 'in_group':
      return item.groupId === c.groupId;
    case 'moved_from_group':
      return ctx.fromGroupId === c.groupId;
    case 'subitem_checked':
      return item.subitems.some((s) => {
        if (c.subitemName && s.name.toLowerCase() !== c.subitemName.toLowerCase()) return false;
        return (s.columns[c.columnId]?.text ?? '') === c.label;
      });
    case 'subitem_not_checked':
      // True when NO matching subitem is at `label` (the negation of subitem_checked).
      return !item.subitems.some((s) => {
        if (c.subitemName && s.name.toLowerCase() !== c.subitemName.toLowerCase()) return false;
        return (s.columns[c.columnId]?.text ?? '') === c.label;
      });
  }
}

function buildContext(item: ItemContext, event: NormalizedEvent): Record<string, unknown> {
  return contextFrom(item, hintsFromEvent(event));
}

/**
 * The bits of a template context only the triggering event knows. Captured when
 * an action is queued so a send-time re-render can reproduce them from a freshly
 * hydrated item (see `RenderHints`).
 */
function hintsFromEvent(event: NormalizedEvent): RenderHints {
  if (event.kind === 'status_changed' && event.label) return { status: event.label };
  if (event.kind === 'subitem_changed') return { subitemName: String((event.raw as any).pulseName ?? '') };
  return {};
}

/** Build the template context from a hydrated item plus the event-derived hints. */
function contextFrom(item: ItemContext, hints: RenderHints): Record<string, unknown> {
  const column: Record<string, string> = {};
  for (const [id, snap] of Object.entries(item.columns)) column[id] = snap.text;

  const ctx: Record<string, unknown> = {
    item: { id: item.id, name: item.name },
    group: { id: item.groupId, title: item.groupTitle },
    status: hints.status ?? item.columns['status']?.text ?? '',
    column,
    // All subitems by name, so templates can scope to a specific one via
    // {{#subitem "Name"}}…{{/subitem}} regardless of the trigger.
    subitems: item.subitems.map((s) => subitemCtx(s, s.name)),
  };

  // For subitem-triggered rules, expose the TRIGGERING subitem so templates can
  // use {{subitem.name}} and {{subitem.column.<id>}}. (A per-action subitemName
  // can override this in renderAction, so even non-subitem triggers can target one.)
  if (hints.subitemName !== undefined) {
    const name = hints.subitemName;
    const sub = item.subitems.find((s) => s.name.toLowerCase() === name.toLowerCase());
    ctx.subitem = subitemCtx(sub, name);
  }

  return ctx;
}

/**
 * Recipients are re-resolved on a re-render, which is the point (a delayed email
 * picks up an address filled in after the rule armed). But if the fresh resolve
 * comes back empty while the armed payload had addresses — a cleared column, a
 * people-column blip — fall back to those rather than dropping the send.
 */
function keepArmedRecipients(actionType: QueuedActionType, armed: unknown, fresh: unknown): unknown {
  if (actionType !== 'email') return fresh;
  const freshTo = (fresh as { to?: string[] }).to ?? [];
  const armedTo = (armed as { to?: string[] })?.to ?? [];
  if (freshTo.length > 0 || armedTo.length === 0) return fresh;
  log.warn('Re-render resolved no email recipients; keeping the ones resolved when the action was armed.');
  return { ...(fresh as object), to: armedTo };
}

/** Shape the `{{subitem.*}}` template context for one subitem (name + columns). */
function subitemCtx(sub: SubitemSnapshot | undefined, fallbackName: string) {
  const column: Record<string, string> = {};
  if (sub) for (const [id, snap] of Object.entries(sub.columns)) column[id] = snap.text;
  return { name: sub?.name ?? fallbackName, column };
}
