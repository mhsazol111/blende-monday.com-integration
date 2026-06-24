import { log } from '../util/logger.js';
import { renderTemplate } from '../util/template.js';
import { htmlToText, htmlToSlack, looksLikeHtml } from '../util/html.js';
import type { NormalizedEvent } from '../events/types.js';
import { hydrateItem, type Hydrator, type ItemContext, type SubitemSnapshot } from '../monday/hydrate.js';
import { defaultSenders, type Senders } from '../senders/index.js';
import { cloneTemplateSubitems, type Cloner } from '../monday/clone.js';
import { setColumnValue, type ColumnWriter } from '../monday/write.js';
import type { EngineStore, QueuedActionType } from '../queue/types.js';
import type { Action, ActionWhen, Condition, Rule, Trigger } from './types.js';

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
}

export interface HandleResult {
  matched: number;
  executed: number;
  scheduled: number;
  cleared: number;
  deferred: number;
  /** Actions that threw (isolated so they don't abort the rest). */
  failed: number;
}

type ActionOutcome = 'executed' | 'scheduled' | 'cleared' | 'deferred' | 'skipped';

export class RulesEngine {
  private rules: Rule[];
  private readonly hydrate: Hydrator;
  private readonly senders: Senders;
  private readonly store?: EngineStore;
  private readonly cloner: Cloner;
  private readonly columnWriter: ColumnWriter;

  constructor(deps: EngineDeps) {
    this.rules = deps.rules;
    this.hydrate = deps.hydrate ?? hydrateItem;
    this.senders = deps.senders ?? defaultSenders;
    this.store = deps.store;
    this.cloner = deps.cloner ?? cloneTemplateSubitems;
    this.columnWriter = deps.columnWriter ?? setColumnValue;
  }

  /** Replace the active ruleset (used by the configurator after a save). */
  setRules(rules: Rule[]): void {
    this.rules = rules;
  }

  async handleEvent(event: NormalizedEvent): Promise<HandleResult> {
    const result: HandleResult = { matched: 0, executed: 0, scheduled: 0, cleared: 0, deferred: 0, failed: 0 };

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

    const item = await this.hydrate(itemId);
    if (!item) {
      log.warn(`Could not hydrate item ${itemId} for event ${event.kind}.`);
      return result;
    }

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
          const outcome = await this.runAction(rule, curItem, action, ctx);
          bump(result, outcome);
          // Re-hydrate after a clone that created subitems so subsequent actions
          // in this rule operate on the fresh subitem list (fixes clone→set_column
          // in one rule, where the original snapshot predates the new subitems).
          if (action.type === 'clone_template_subitems' && outcome === 'executed') {
            const fresh = await this.hydrate(curItem.id);
            if (fresh) { curItem = fresh; ctx = buildContext(curItem, event); }
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
  ): Promise<ActionOutcome> {
    if (action.type === 'clear_pending') {
      if (!this.store) {
        log.info(`[rule ${rule.id}] clear_pending requires a store; skipped.`);
        return 'deferred';
      }
      const n = this.store.cancelPendingForItem(item.id);
      log.info(`[rule ${rule.id}] clear_pending cancelled ${n} action(s) for item ${item.id}.`);
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

    // set_column targeting a subitem: make sure the named subitem exists before
    // scheduling/sending, so we never enqueue an unwritable action.
    if (action.type === 'set_column' && action.target === 'subitem') {
      if (!findSubitemByName(item, action.subitemName)) {
        log.warn(`[rule ${rule.id}] set_column: subitem "${action.subitemName}" not found on item ${item.id}; skipped.`);
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
      this.store.enqueue({ itemId: item.id, ruleId: rule.id, actionType, payload, dueAt });
      log.info(`[rule ${rule.id}] ${action.type} scheduled for ${new Date(dueAt).toISOString()}.`);
      return 'scheduled';
    }

    await this.dispatch(action.type, renderAction(action, ctx, item).payload);
    return 'executed';
  }

  /** Send a rendered payload now (also used by the worker for due actions). */
  async dispatch(actionType: QueuedActionType, payload: unknown): Promise<void> {
    if (actionType === 'email') {
      const p = payload as { to: string[]; subject: string; body: string; html?: string };
      await this.senders.sendEmail(p);
    } else if (actionType === 'set_column') {
      const p = payload as { boardId: number; itemId: number; columnId: string; value: string };
      await this.columnWriter(p);
    } else {
      const p = payload as { webhookUrl: string; text: string };
      await this.senders.sendSlack(p);
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
        to: mergeRecipients(action.to, action.toFromColumn, item),
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

/** Combine literal recipients with those resolved from a people column. */
function mergeRecipients(
  to: string[] | undefined,
  toFromColumn: string | undefined,
  item: ItemContext,
): string[] {
  const literal = to ?? [];
  const fromColumn = toFromColumn ? (item.people[toFromColumn] ?? []) : [];
  return [...new Set([...literal, ...fromColumn])];
}

function bump(result: HandleResult, outcome: ActionOutcome) {
  if (outcome === 'executed') result.executed++;
  else if (outcome === 'scheduled') result.scheduled++;
  else if (outcome === 'cleared') result.cleared++;
  else if (outcome === 'deferred') result.deferred++;
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
    return !!rule.scope.groupId && rule.scope.groupId === leftGroup;
  }
  return scopeMatches(rule, item);
}

function scopeMatches(rule: Rule, item: ItemContext): boolean {
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
  }
}

function buildContext(item: ItemContext, event: NormalizedEvent): Record<string, unknown> {
  const column: Record<string, string> = {};
  for (const [id, snap] of Object.entries(item.columns)) column[id] = snap.text;

  let status = item.columns['status']?.text ?? '';
  if (event.kind === 'status_changed' && event.label) status = event.label;

  const ctx: Record<string, unknown> = {
    item: { id: item.id, name: item.name },
    group: { id: item.groupId, title: item.groupTitle },
    status,
    column,
  };

  // For subitem-triggered rules, expose the TRIGGERING subitem so templates can
  // use {{subitem.name}} and {{subitem.column.<id>}}. (A per-action subitemName
  // can override this in renderAction, so even non-subitem triggers can target one.)
  if (event.kind === 'subitem_changed') {
    const name = String((event.raw as any).pulseName ?? '');
    const sub = item.subitems.find((s) => s.name.toLowerCase() === name.toLowerCase());
    ctx.subitem = subitemCtx(sub, name);
  }

  return ctx;
}

/** Shape the `{{subitem.*}}` template context for one subitem (name + columns). */
function subitemCtx(sub: SubitemSnapshot | undefined, fallbackName: string) {
  const column: Record<string, string> = {};
  if (sub) for (const [id, snap] of Object.entries(sub.columns)) column[id] = snap.text;
  return { name: sub?.name ?? fallbackName, column };
}
