/**
 * Rule schema. A rule = one trigger + zero-or-more AND conditions + one-or-more
 * actions. See CLAUDE.md §4 for the agreed spec and behavioral defaults.
 */

// ── Timing ────────────────────────────────────────────────────────────────
export type ActionWhen =
  | { mode: 'immediate' }
  | { mode: 'relative'; days?: number; hours?: number; minutes?: number }
  | { mode: 'absolute'; at: string }; // ISO-8601

// ── Triggers ─────────────────────────────────────────────────────────────
export type Trigger =
  | { type: 'item_entered_group' }
  | { type: 'item_left_group' }
  // Legacy: superseded by item_column_changed (kept so old saved rules still run).
  | { type: 'status_changed_to'; columnId: string; label: string }
  // Any item column changed. `value` omitted → fires on ANY change to the column;
  // set → fires only when the column's text becomes `value` (status = its label).
  | { type: 'item_column_changed'; columnId: string; value?: string }
  // For our boards "checked" = a subitem's status column reaching `label` (e.g. "Done").
  | { type: 'subitem_checked'; columnId: string; label: string; subitemName?: string }
  // Fires once when the LAST of `subitemNames` reaches `label` — order-independent.
  | { type: 'all_subitems_checked'; columnId: string; label: string; subitemNames: string[] }
  // Timed — scheduled at group entry; dispatched by the worker (Phase 4).
  | { type: 'item_in_group_for_days'; days: number; repeatEveryDays?: number };

// ── Conditions (AND-combined) ───────────────────────────────────────────────
export type Condition =
  | { type: 'status_is'; columnId: string; label: string }
  | { type: 'status_is_not'; columnId: string; label: string }
  | { type: 'column_equals'; columnId: string; value: string }
  | { type: 'column_empty'; columnId: string }
  | { type: 'column_not_empty'; columnId: string }
  | { type: 'in_group'; groupId: string }
  // True when the item was just moved OUT of `groupId` (uses monday's sourceGroupId).
  | { type: 'moved_from_group'; groupId: string }
  | { type: 'subitem_checked'; columnId: string; label: string; subitemName?: string };

// ── Actions ─────────────────────────────────────────────────────────────────
export interface EmailAction {
  type: 'email';
  when: ActionWhen;
  to?: string[];
  /** People/email column id to resolve recipients from (Phase 5). */
  toFromColumn?: string;
  subject: string;
  body: string;
}

export interface SlackAction {
  type: 'slack';
  when: ActionWhen;
  /** Overrides the default SLACK_WEBHOOK_URL when set. */
  webhookUrl?: string;
  text: string;
}

export interface ClearPendingAction {
  type: 'clear_pending';
}

/**
 * Clone subitems from a matching template item (ported from the legacy PHP
 * plugin). Immediate-only; intended for `item_entered_group` triggers.
 */
export interface CloneTemplateSubitemsAction {
  type: 'clone_template_subitems';
  templatesGroupTitle: string;
  templateSourceColumnId: string;
}

/**
 * Write a value back to monday (the item or one of its subitems). Uses
 * `change_simple_column_value`, so `value` is a simple string: the label INDEX
 * for status/color columns, otherwise the literal text/number/date. Supports
 * `{{templating}}`. Can be immediate or scheduled (via `when`).
 */
export interface SetColumnAction {
  type: 'set_column';
  when: ActionWhen;
  /** 'item' (default) writes the item's column; 'subitem' writes a named subitem's column. */
  target?: 'item' | 'subitem';
  /** Required when target='subitem': the subitem to update, matched by name. */
  subitemName?: string;
  columnId: string;
  value: string;
}

export type Action =
  | EmailAction
  | SlackAction
  | ClearPendingAction
  | CloneTemplateSubitemsAction
  | SetColumnAction;

// ── Rule ────────────────────────────────────────────────────────────────────
export interface RuleScope {
  groupId?: string;
  groupTitleContains?: string;
}

export interface Rule {
  id: string;
  enabled: boolean;
  boardId: number;
  scope: RuleScope;
  trigger: Trigger;
  conditions?: Condition[];
  actions: Action[];
}
