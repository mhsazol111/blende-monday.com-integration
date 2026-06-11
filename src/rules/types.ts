/**
 * Rule schema. A rule = one trigger + zero-or-more AND conditions + one-or-more
 * actions. See CLAUDE.md §4 for the agreed spec and behavioral defaults.
 */

// ── Timing ────────────────────────────────────────────────────────────────
export type ActionWhen =
  | { mode: 'immediate' }
  | { mode: 'relative'; days?: number; hours?: number }
  | { mode: 'absolute'; at: string }; // ISO-8601

// ── Triggers ─────────────────────────────────────────────────────────────
export type Trigger =
  | { type: 'item_entered_group' }
  | { type: 'item_left_group' }
  | { type: 'status_changed_to'; columnId: string; label: string }
  | { type: 'item_moved' }
  // For our boards "checked" = a subitem's status column reaching `label` (e.g. "Done").
  | { type: 'subitem_checked'; columnId: string; label: string; subitemName?: string }
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

export type Action =
  | EmailAction
  | SlackAction
  | ClearPendingAction
  | CloneTemplateSubitemsAction;

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
