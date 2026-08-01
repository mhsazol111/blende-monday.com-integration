# CLAUDE.md — Project handoff & working notes

> **Read this first.** It lets any new session resume without re-deriving context.
> Keep the **Current status** section updated at the end of each working session.

---

## 1. Project overview

We are building **`monday-automation-service`**: a config-driven notification & automation engine
for monday.com. It receives monday webhooks and runs per-group rules shaped as:

> **WHEN** _trigger_ — **IF** _conditions_ — **THEN** _actions_

Actions are **email** and/or **Slack** notifications that can fire **immediately** or be
**scheduled** for later, and can be **cleared per item**.

**Why:** the client has monday boards with groups/items/subitems. They need flexible, per-group
automated notifications that monday's built-in automations can't express (multi-subitem conditions,
day-based scheduling, "clear all queued actions for an item", arbitrary email content).

**History:** the original proof-of-concept was `monday-subitem-cloner.php`, a WordPress plugin that
(a) cloned template subitems on item create/move and (b) fired one hardcoded Slack+email when an
item entered one group. Everything in it was hardcoded. WordPress was only a fast test host.
**That PHP plugin is now retired** — its behavior is fully ported into this standalone service
(cloning → the `clone_template_subitems` action). No `.php` file remains in this repo.

---

## 2. Current status

- **Phase 0 (Scaffolding & handoff): DONE** — Node/TS skeleton, env config, logger, README, this
  file. `npm install`, `npm run typecheck`, and `npm run dev` all verified working.
- **Phase 1 (monday read client + discovery): DONE & LIVE-VERIFIED** — `mondayGraphql` client
  (`src/monday/client.ts`), board/subitem discovery (`src/monday/discovery.ts`), and `npm run
  discover` CLI (`src/scripts/discover.ts`). Verified against the real board (read-only). See the
  discovered IDs in section 5.
- **Phase 2 (Ingress + normalizer, log-only): CODE COMPLETE & OFFLINE-VERIFIED** — Fastify server
  (`src/server.ts`) with `/health` and `/webhook` (challenge handshake + shared-secret check),
  canonical event model (`src/events/types.ts`), defensive normalizer (`src/monday/normalizer.ts`).
  Verified via `npm run test:ingress` (10 checks, Fastify `inject`, no network). **Remaining live
  step:** expose the server on a public URL (e.g. tunnel) and register monday webhooks so real
  payloads arrive — and reconcile the normalizer field names against those real payloads.
- **Phase 3 (Rules engine, instant path): CODE COMPLETE & OFFLINE-VERIFIED** — rule schema
  (`src/rules/types.ts`), JSON loader+validation (`src/rules/loader.ts`), engine with
  trigger/scope/condition matching and immediate email/slack actions (`src/rules/engine.ts`),
  item hydrator (`src/monday/hydrate.ts`), senders (`src/senders/index.ts` — **email is DRY-RUN/log
  for now**, Slack live), `{{...}}` templating (`src/util/template.ts`), sample rules
  (`config/rules.json`), engine wired into `/webhook`. Verified via `npm run test:engine` (11
  checks, mock hydrator + capturing senders). Scheduled (`relative`/`absolute`) actions and
  `clear_pending` are recognised but **deferred to the Phase 4 queue** (logged, not yet executed).
- **Phase 4 (Queue + scheduler): CODE COMPLETE & OFFLINE-VERIFIED** — SQLite store via Node's
  built-in `node:sqlite` (`src/db/store.ts`), queue/store contracts (`src/queue/types.ts`), worker
  loop (`src/worker.ts`), engine extended for scheduled (`relative`/`absolute`) enqueue, timed
  `item_in_group_for_days` armed at entry, real `clear_pending`, auto-clear on leave, and re-entry
  reset; ingress now dedupes resends via `processed_events`. Verified via `npm run test:queue` (14
  checks, in-memory DB). Run all suites with `npm test`.
- **Phase 5 (Recipients & polish): DONE & OFFLINE-VERIFIED** — people-column → email resolution
  (`src/monday/hydrate.ts` `resolvePeople` + `ItemContext.people`), engine merges literal +
  column recipients (deduped), real SMTP via nodemailer when `SMTP_HOST` set (else dry-run,
  `src/senders/index.ts`), worker retry with backoff + max-attempts (`attempts` column,
  `retryLater`). Verified via `npm run test:polish` (6 checks).
- **Phase 6 (Cutover): CODE COMPLETE & OFFLINE-VERIFIED; LIVE CUTOVER PENDING CLIENT INFRA** — the
  legacy PHP cloner is ported to `src/monday/clone.ts` and exposed as a `clone_template_subitems`
  action so the new service has feature parity; verified via `npm run test:cutover` (9 checks). The
  full server (ingress + engine + store + worker) boots and responds (smoke-tested on a live port,
  including a real monday hydrate call). **Remaining live steps are in §10 (Cutover runbook)** and
  require a public URL + registering monday webhooks + monday write access — not yet performed.

- **Phase 7 (Configurator UI): DONE & VERIFIED** — backend API + a dependency-free single-page rule
  builder served by the same Fastify service. Routes in `src/web/admin.ts`: `GET /` + `GET /app.js`
  (static UI in `web/`), `GET /api/config`, `GET /api/discover?boardId=`, `GET /api/rules`,
  `PUT /api/rules` (validates, saves to the rules file, hot-reloads the engine via
  `RulesEngine.setRules`), `GET /api/group-subitems?boardId=&groupId=` (distinct subitem names in a
  group, via `getGroupSubitemNames` — items first, template fallback). The UI (`web/index.html`,
  `web/app.js`) loads a board, builds rules from **API-fed dropdowns** (groups, status columns +
  their labels, people columns, subitem columns, **and a real subitem-name picker** for
  `subitem_checked`), and edits a canonical ruleset JSON. Verified via `npm run test:admin` (7
  checks) and live boots (UI served; `/api/discover` and `/api/group-subitems` returned real data).

- **Live realtime verified (2026-06-11):** a real subitem→Done change on the board fired a rule and
  posted to Slack end-to-end through a tunnel (`matched:1, executed:1`). Found & fixed the
  subitem cross-board bug (see §5) and reconciled the real payload shape.
- **Deployment ready (2026-06-12):** `Dockerfile` + `.dockerignore` added; `loadRules` is now
  boot-safe (no crash when the rules file is absent — fresh deploys start with 0 rules); debug route
  `GET /api/last-events` (last 20 raw payloads) added for payload reconciliation. See §11 for Coolify.

- **Multi-subitem trigger added (2026-06-12):** `all_subitems_checked` (trigger + condition combo
  for "subitem A AND subitem B done" used to silently miss when the trigger subitem was completed
  before the condition subitem — only the trigger subitem re-evaluates the rule). The new trigger
  fires once when the LAST of `subitemNames[]` reaches the label, in any order, ignoring unrelated
  subitems. Engine: `allSubitemsAtLabel`; UI: multi-subitem picker.

**Webhook self-service added (2026-06-17):** boards are connected to monday from the configurator —
no manual API calls. `src/monday/webhooks.ts` (list/create/delete + idempotent `reconcileWebhooks`
over a managed event set), admin routes `GET /api/webhooks`, `POST /api/webhooks/register`,
`DELETE /api/webhooks/:id` (`src/web/admin.ts`), a "Connect this board" card in the UI, and a
debugging CLI `npm run webhooks -- [list|register|delete]` (`src/scripts/webhooks.ts`).
  - **Managed registration events** (WebhookEventType names, NOT payload `type` names):
    `create_item`, `item_moved_to_any_group`, `change_column_value`, `change_subitem_column_value`.
    `item_in_group_for_days` needs no webhook (worker-driven). **monday has NO board-move webhook**
    (verified via `__type(name:"WebhookEventType")` introspection) — so the `item_moved`
    cross-board trigger can't be webhook-driven and is excluded from the managed set + flagged in
    the UI. (An earlier draft wrongly included `move_item_to_board`, which always failed to create.)
  - **Registration requires a public URL monday can reach** — registering from `http://localhost`
    fails (`monday GraphQL error`). Register against the deployed HTTPS URL (set `PUBLIC_URL` or call
    the API from the deployed instance).
  - `register` is idempotent (reconciles to one webhook per event) and per-event resilient (an
    unsupported event lands in `failed`, the rest still register). The monday API does not return a
    webhook's URL, so reconcile **deletes + recreates** managed-event hooks at the current URL.
  - URL = `<PUBLIC_URL or derived-from-request>/webhook?secret=<WEBHOOK_SHARED_SECRET>`. The CLI
    needs `PUBLIC_URL`; the UI button derives the origin from request headers if `PUBLIC_URL` unset.
  - **Prod board `18403436566` is fully connected (verified 2026-07-29 via `npm run webhooks --
    list`):** all four managed events are registered — `create_item` (595416878),
    `item_moved_to_any_group` (595416912), `change_column_value` (595416934),
    `change_subitem_column_value` (595416954). (An earlier note here said `change_column_value` was
    missing; it has since been registered.) Registration itself still has to be run from the
    deployed HTTPS URL — localhost can't register.

**Configurator UX additions (2026-06-17):**
  - **Scheduled-actions (queue) management** — `GET /api/queue`, `POST /api/queue/:id/run` (dispatch
    now), `POST /api/queue/:id/reschedule` ({at: ISO}), `DELETE /api/queue/:id`; store methods
    `listActions`/`getAction`/`rescheduleAction`/`deleteAction`. UI "Scheduled actions" card lists
    pending/sent with run-now / reschedule / delete. `registerAdmin(app, engine, store)` now takes
    the store.
  - **Rich-text messages** — email body & Slack text are authored in a dependency-free
    contenteditable editor (HTML). `src/util/html.ts` converts: email sends HTML + a plain-text
    fallback (`htmlToText`); Slack gets mrkdwn (`htmlToSlack`: *bold*, _italic_, `<url|text>`,
    bullets). Plain-text rules still work unchanged (`looksLikeHtml` guards). `EmailMessage.html`
    added; engine renders both forms.
  - **Variable helper** — clickable chips in each editor insert `{{item.name}}`, `{{group.title}}`,
    `{{status}}`, and `{{column.<id>}}` for every board column (built client-side from the loaded
    structure; mirrors engine `buildContext`).
  - **Edit saved rules** — each rule in the list has an "edit" button that reloads it into the
    builder (trigger/conditions/actions prefilled); re-adding with the same ID overwrites.

**`moved_from_group` condition (2026-06-17):** monday's `move_pulse_into_group` payload carries
`sourceGroupId` (verified via `/api/last-events`); the normalizer maps it to
`ItemEnteredGroupEvent.fromGroupId`, and the engine evaluates `moved_from_group` against it via a
`ConditionContext`. Catches a specific transition (e.g. NP Intake → HPSM) reliably, even on a
first move (no DB history needed).

**`set_column` write-back + minutes scheduling (2026-06-17):** new `set_column` action writes to
monday via `change_simple_column_value` (`src/monday/write.ts`, injectable `ColumnWriter` on the
engine; `QueuedActionType` gained `set_column` so it schedules through the queue/worker). Targets the
item or a named subitem (subitem hydration now carries `boardId`; missing subitem → skipped, never
enqueued). The `when` relative mode gained **minutes** (UI inputs now labelled Days/Hours/Minutes).
UI: "Set a monday value" action with item/subitem target, column picker, and a label-index dropdown
for status columns (free text otherwise).

**Action isolation (2026-06-17):** the engine's per-rule action loop now runs each action in its own
try/catch — a throwing action (e.g. a Slack webhook returning non-200) no longer aborts the
remaining actions or other matched rules. Failures are logged (`[rule X] action "Y" failed`) and
counted in `HandleResult.failed`. (Found while debugging "subitem set_column not updating": a
`[clone, slack, set_column]` rule was aborting before `set_column` when an earlier action threw.)

**Re-hydrate after clone (2026-06-17):** within a rule, after a `clone_template_subitems` action
returns `executed` (created subitems), the engine re-hydrates the item so subsequent actions see the
new subitems. This makes the common `[clone_template_subitems, …, set_column(subitem)]` pattern work
on freshly-created items (previously the set_column used the pre-clone snapshot and skipped). A time
delay does NOT solve this — the subitem is resolved at event time from the snapshot, not at send
time — so re-hydration is the correct fix.

**`item_left_group` fixed (2026-06-17):** monday delivers a group move as ONE `move_pulse_into_group`
event (normalized to `item_entered_group` with `fromGroupId`), so the engine never saw an
"item_left_group" event and the trigger could never fire. Now `triggerKindMatches` treats a move as a
leave of its source group, and a trigger-aware `ruleScopeMatches` scopes `item_left_group` rules to
`event.fromGroupId` (the group left) rather than the item's current group. A single A→B move fires
both `item_entered_group`(B) and `item_left_group`(A) rules. (Immediate actions are the intended use;
a *scheduled* `item_left_group` action would be cancelled by the auto-clear-on-leave in
`onEnteredGroup` — noted, not addressed.)

**`item_column_changed` trigger (2026-06-17):** generalized the status-only `status_changed_to` into
a trigger for ANY item column. `value` omitted → fires on any change to the column; `value` set →
fires when the column's hydrated text equals it (case-insensitive; status uses its label). Engine:
`triggerKindMatches` consumes both `status_changed` and `column_changed`; `triggerDetailsMatch`
matches the changed columnId; post-hydration `itemColumnMatches` checks the value. The single
registered `change_column_value` webhook already delivers all column types. Legacy `status_changed_to`
still runs and is migrated to `item_column_changed` when edited in the UI.

**Subitem template vars + richer email editor (2026-06-17):**
  - `buildContext` now exposes the **triggering subitem** on subitem-based rules: `{{subitem.name}}`
    and `{{subitem.column.<id>}}` (resolved from the changed subitem on the hydrated parent). The UI
    variable chips list these whenever the board has a subitem board.
  - **`&nbsp;` fix:** `looksLikeHtml` now also detects HTML entities, so contenteditable output with
    `&nbsp;` (spaces) is decoded for the text/Slack forms and sent as HTML for email — previously it
    leaked `&nbsp;` literally when the body had entities but no tags.
  - **Editor upgrades:** the rich editor gained headings, strikethrough, ordered list, alignment,
    text color, unlink, and a **`</>` raw-HTML source toggle** (paste full email templates). Variable
    chips insert into either the rich view or the HTML source.

**Configurator redesign (2026-06-17):** `web/index.html` + `web/app.js` rebuilt — modern light
(monday-style) theme, **tabbed** layout (Rules / Scheduled actions / Board & connect), **one-step
"Save rule"** (validates + upserts + PUTs to the server instantly, with optimistic rollback; delete
persists too; the JSON box is now an "Advanced — apply & save" `<details>`), a dependency-free
**searchable `combo()`** replacing the long column/group/people selects, **loading spinners** (board,
subitems, queue, connect), scrollable lists with empty states, and **toast** feedback. Board
auto-loads from `/api/config` on open. All rule/condition/action/trigger **serialize shapes are
unchanged** (saved rules stay compatible). Backend untouched; `node --check` + live serve verified.

**Clear-on-move ordering fix (2026-06-17):** moving an item A→B (one `move_pulse_into_group` →
`item_entered_group`, reason `moved`) cancelled the DESTINATION group's just-enqueued scheduled
actions. Cause: the auto-clear-on-move lived in `onEnteredGroup`, which runs AFTER the instant rule
loop — so it enqueued B's 48h action, then `cancelPendingForItem` wiped it along with A's leftovers.
Fix: the clear-on-move (`prev.groupId !== item.groupId → cancelPendingForItem`) now runs right after
hydration, BEFORE the rule loop; `onEnteredGroup` only records the new entry + arms timed rules.
A→B move now clears A's pending but keeps B's freshly-scheduled action. Regression test in
`test:queue` case I (immediate actions on a create-in-place rule were never affected — that path has
no prior group entry, which is why a create-in-group rule worked but a move-into-group rule didn't).

**Microsoft Exchange (Graph) email provider added (2026-06-23):** email now has **two** transports,
selected by `EMAIL_PROVIDER` (`graph` | `smtp` | `auto`, default `auto`). `auto` → Graph if its
creds are set, else SMTP if `SMTP_HOST` set, else dry-run. The Graph transport
(`src/senders/graph.ts`, `sendViaGraph`) uses **OAuth2 client-credentials** (app-only) against an
Azure app registration with the `Mail.Send` **application** permission — no mailbox password — via
`POST /users/{sender}/sendMail` on Graph v1.0, with a module-level token cache (refreshed ~60s
before expiry). Built on the global `fetch` (no new npm dependency). Wired into
`defaultSenders.sendEmail` (`src/senders/index.ts`) via `resolveEmailProvider()`; the SMTP/nodemailer
path is unchanged. New env vars: `EMAIL_PROVIDER`, `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`,
`MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_SENDER` (see `.env.example`). The `EmailMessage`/`Senders`
interface, engine `dispatch`, worker, and queue are untouched. **Client setup instructions** (what
the M365 admin must create + the 5 values to hand over) are in **`docs/EXCHANGE-SETUP.md`**. Verified
offline via `npm run test:exchange` (12 checks: token shape, sendMail URL/Bearer/body, HTML-vs-Text
content type, non-2xx → throw, token caching).

> **Fixed (2026-06-23):** `test:admin`'s first check asserted the served HTML contained
> `'rule configurator'`, stale since the 2026-06-17 UI redesign retitled it
> `Blende — automation configurator`; updated to match (`'automation configurator'`).

**OR condition groups + template if/else + rich set_column + delay-from-column (2026-06-24):** five
configurator/engine features.
  - **OR conditions (OR-of-ANDs):** `Rule.conditionGroups?: ConditionGroup[]` added alongside legacy
    flat `conditions` (`src/rules/types.ts`). Engine `conditionsPass(rule, …)` passes when ANY group
    passes (AND within a group); legacy flat `conditions` = one AND group → fully backward compatible
    (`src/rules/engine.ts`). UI: `makeConditionGroup()` + `renderConditionGroups()` render groups
    joined by "OR" with a "+ OR group" button; `buildRule` emits `conditionGroups`, edit-prefill reads
    groups (or wraps legacy `conditions`).
  - **"Subitem is" + empty value:** the `subitem_checked` condition is relabelled "Subitem is" and the
    status-label dropdown's first option is now an explicit "(no value / empty)" (serializes `label:
    ''`). Engine already matched `''` as empty — no engine change; loader allows empty label. Same
    empty option added to `status_is`/`status_is_not` conditions.
  - **If/else in messages:** `src/util/template.ts` gained `renderConditionals` (runs before `{{var}}`
    substitution) supporting `{{#if path}}…{{else}}…{{/if}}`, `{{#unless}}`, and `{{#ifEquals path
    "value"}}…{{/ifEquals}}` (case-insensitive value check), nestable. Works in email/Slack/set_column
    automatically (all flow through `renderTemplate`). UI: "Insert condition" snippet chips in
    `richEditor` (`conditionalSnippets()`), seeded with a real board column id.
  - **Rich-text "Set a monday value":** the set_column free-text value (non-status columns) now uses
    the `richEditor`; the engine flattens HTML → plain text on write (`looksLikeHtml ? htmlToText`),
    so a generated message can be stashed in a column for manual reuse. Status/color columns keep the
    label-index `<select>`. No schema change.
  - **Delay from a column:** new `ActionWhen` mode `relative_from_column` (`target`/`subitemName`/
    `columnId`/`unit`). `dueAtFor(when, item, base)` reads the hydrated item/subitem column number ×
    unit (days/hours/minutes) at event time; NaN/missing → `base` (warn). UI: 4th "after a delay
    from a column value" mode in `whenControl`, whose column picker is filtered to **number/dropdown**
    columns (the saved column stays visible when editing). Loader validates the new mode.
  - **Timed rules honor an action's `when`:** `dueAtFor` now takes a `base`; the
    `item_in_group_for_days` path passes the N-days mark as the base, so an action's `when` **layers
    on top** (immediate → fires at N days; relative / relative_from_column → N days + that delay;
    absolute → its own timestamp). Previously the timed path forced every action to exactly N days.
  - Verified: `npm run test:engine` extended (+14 → 52 checks: OR groups, template if/else+nesting,
    set_column plain-text, relative_from_column timing); live PUT/GET round-trip of a rule using all
    new shapes succeeds.

**Named-subitem template var on any trigger (2026-06-24):** `{{subitem.name}}` / `{{subitem.column.<id>}}`
previously only resolved on subitem-triggered rules (from the changed subitem's `pulseName`), so a
message on an `item_entered_group` (or any non-subitem) trigger rendered them blank. `EmailAction`
and `SlackAction` gained an optional `subitemName` (`src/rules/types.ts`); when set, `renderAction`
overrides `{{subitem.*}}` with that named subitem from the hydrated item via a new `withNamedSubitem`
helper + a shared `subitemCtx` (extracted from `buildContext`) — so subject/body/text can reference a
specific subitem regardless of trigger. Missing subitem → blank + warn (no throw). Works for
immediate and scheduled sends (renderAction is shared). For a clone→message rule, place the message
**after** `clone_template_subitems` (engine re-hydrates post-clone). UI (`web/app.js`): the email/slack
action editors show a "Subitem for {{subitem.*}} (optional)" picker (reusing `subitemNamePicker`) when
the board has a subitem board. Loader needs no change (extra fields are permitted). Verified:
`test:engine` +2 (15b named subitem on non-subitem trigger, 15c missing → blank).

**Named-subitem template blocks (2026-06-25):** a message can now reference **multiple specific
subitems** and branch on each. New scoping block in `src/util/template.ts`:
`{{#subitem "Exact Name"}}…{{/subitem}}` — inside it `{{name}}`, `{{column.<id>}}`, `{{subitem.*}}`
and the existing conditionals resolve against that named subitem (matched case-insensitively against
`context.subitems`). A `renderSubitemBlocks` pre-pass runs before `renderConditionals` (balanced
`findSubitemClose` scanner for nesting; recurses via `renderTemplate` with a `scopeForSubitem` child
context). Missing subitem → its name + empty columns (conditionals fall to `{{else}}`); unbalanced
tags emit literally. `buildContext` (`src/rules/engine.ts`) now exposes `ctx.subitems` (all subitems
as `{name, column}` via the shared `subitemCtx`). Templates without the block are byte-identical to
before. UI: a "subitem block" snippet chip (`conditionalSnippets`, gated on a subitem board)
pre-filled with a real subitem name (`subitemNamePicker` caches `state.groupSubitemNames`). Verified:
`test:engine` +3 (per-name scope, missing → else, nested blocks).

**Rich editor hardened + polished (2026-06-25):** the configurator's `richEditor` (`web/app.js`)
was a raw `contenteditable`/`execCommand` widget that emitted stray `<div>`s, random `&nbsp;`, and
Word/Docs paste junk. Hardened (no library — keeps the zero-dep/no-build design + email fidelity):
`defaultParagraphSeparator='p'` + `styleWithCSS=false` on focus (consistent `<p>`, semantic
`<b>/<i>`); a **paste sanitizer** (`sanitizeHtml`/`walkClean`, tag+attr whitelist `RICH_ALLOWED`,
drops `class`/mso/`<o:p>`/comments/script, `<font>`→`<span style=color>`); **output normalization**
(`normalizeHtml`: nbsp→space, removes empty nodes, collapses/trims `<br>`) applied in `getHtml`/
source-toggle **only for simple rich text** — full HTML email templates (`hasUnsupportedTags`, e.g.
tables) round-trip **verbatim**; toolbar buttons now reflect the caret (`queryCommandState`); link
button adds `https://`. `src/util/html.ts` gained `<s>/<strike>/<del>`→Slack `~text~`. CSS
(`web/index.html`): taller editor (180px), toolbar merged to the editor, and a restyled
`.insert-panel` for the variable/condition/subitem chips. Verified in a real browser (Playwright):
sanitize/normalize/round-trip all correct, no console errors. `test:engine` +1 (`<s>`→`~`).

**Generated Rule IDs include the group (2026-06-24):** the configurator's "Generate" button now
produces `{group-slug}-{trigger}-{random}` (was `{trigger}-{random}`) so the rule list shows which
group a rule targets. `generateRuleId()` slugifies the selected group's title (`web/app.js`); falls
back to `{trigger}-{random}` when no group is picked. UI-only; server treats IDs as opaque.

**Fire-time condition re-check + scoped clear_pending + `subitem_not_checked` (2026-07-01):** two
gaps found while authoring the client's rules (`docs/AUTOMATION-RULES.md`), plus a mirror condition.
  - **Timed rules now honor Conditions — at fire time.** `item_in_group_for_days` still arms on group
    entry (scope only, in `onEnteredGroup`), but the worker now calls a new
    `RulesEngine.shouldFireQueued(ruleId, itemId)` before each dispatch: for a timed rule **with
    conditions**, it re-hydrates the item and re-evaluates `conditionsPass`; if it no longer holds,
    the action is skipped and `store.markCancelled`ed. So a "remind unless signed/booked" reminder
    self-cancels — no cancel rule needed. Non-timed / condition-less / un-hydratable → fires (never
    silently drop). `runDueActions` returns a new `skipped` count. This supersedes the old behavior
    where timed-rule conditions were accepted by the UI/loader but ignored by the engine.
  - **`clear_pending` is now scopable.** `ClearPendingAction` gained `scope?: 'all' | 'rules'` +
    `ruleIds?: string[]`; `store.cancelPendingForItem(itemId, ruleIds?)` adds `AND rule_id IN (…)`
    when scoped. Auto-clear-on-leave/move still pass no ruleIds (clear all). UI: the clear_pending
    action editor has an "All pending actions" / "Only specific rules" select + a rule-ID checkbox
    list. Legacy `{ type: 'clear_pending' }` rules are unchanged (default = all).
  - **New `subitem_not_checked` condition** ("Subitem is not") — the negation of `subitem_checked`,
    so "treatment plan is NOT Done" is expressible (needed for the re-check to gate Rule 6). Mirrors
    the `status_is` / `status_is_not` pair; UI reuses the same row renderer.
  - No DB schema change (the queue already stores `rule_id`). Verified: `test:queue` +8 (24→32),
    `test:engine` +6 (60→66).

**Condition builder → Field/Operator/Value (2026-07-01):** the configurator's condition rows were a
flat list of nine fixed types (`status_is`, `status_is_not`, `column_equals`, …). Rebuilt as a
query-builder — **Subject** (Item column / Subitem / Item's group) → **Operator** (is equal / is not
equal / has any value / has no value; group: is in / moved from) → **Value** (a label dropdown when
the chosen column has labels, else a text field; hidden for the "has value" operators). `web/app.js`
`makeConditionRow` rewritten with `decodeCondition` (reverse-maps saved conditions, incl. legacy
`status_is`/`status_is_not`, back into the controls). Engine gained one additive type
`column_not_equals` (`conditionPass`, `src/rules/types.ts`) so "is not equal" on a normal column
serializes cleanly; all legacy types still recognized, so saved rules are unaffected (editing a
`status_is` rule re-saves it as `column_equals`). UI-only + 1 engine type; `test:engine` +2 (66→68).

The former PHP plugin is **retired** — its cloning logic is fully ported to `src/monday/clone.ts`
(exposed as the `clone_template_subitems` action), so nothing outside this service processes the
board. (Suite counts are tracked at the end of this section.)

**`post_update` action added (2026-07-08):** posts an item **Update** (monday `create_update`) instead
of writing a column — the fix for the long_text **~2000-char cap** (monday enforces it; oversized
writes are rejected). Modeled on `set_column`: item or named-subitem target, `when` scheduling,
`{{templating}}`, and the same rich editor. Unlike `set_column` (which flattens HTML → plain text on a
column write), `post_update` posts the **rich HTML body verbatim** — monday Updates render it and have
no length cap, so it's the right home for a long email a human reads/copies off the item. Wiring:
`postItemUpdate`/`UpdateWriter` (`src/monday/write.ts`, injectable on the engine like `columnWriter`),
`PostUpdateAction` + `Action` union (`src/rules/types.ts`), `QueuedActionType` gains `post_update`
(schedules through queue/worker), engine `renderAction`/`dispatch` + subitem-existence gate
(`src/rules/engine.ts`), loader validation (`src/rules/loader.ts`), and a "Post an update" editor
(`postUpdateControls`, `web/app.js`). Caveat: monday Updates render only a subset of HTML
(bold/italic/lists/links/breaks) — complex tables/inline-CSS templates render plainer, but content is
never truncated. `test:engine` +3 (68→71).

**Email recipients from any column (2026-07-16):** the email action's only column-based recipient
source was a **people** column ("To (from people column)"), but `person` is internal ownership here —
its hydrated `.text` is a person's *name* ("Alyssa"), and the client's real addresses live in
**Patient Email** (`email_mm5az59s`, type `email`) and **Referring Provider Email** (`text_mm2wm34h`,
type `text`). `EmailAction` gained **`toFromColumns?: string[]`** (`src/rules/types.ts`) — multi-select,
merged with the literal `to` and deduped; the old single `toFromColumn` is deprecated but still
honored (11 live rules in `config/rules.json` use it). Engine: `mergeRecipients(action, item)` now
takes the action and resolves each id via a new `emailsFromColumn` — the `people` map first (only the
`users()` lookup can turn a person into an address), else the column's own data: **an email column's
`value` JSON is parsed for its `email` key** (its `.text` may be a display label, not the address),
else `.text` is split on commas/semicolons/whitespace and filtered by `EMAIL_RE`. That regex is also
the safety net that stops a people column's name leaking in as a recipient. **No new monday API call** —
`hydrateItem` already snapshots `{text, value, type}` for every column. Loader accepts the new key;
UI (`web/app.js`) swaps the single people combo for a checkbox list (reusing the `clear_pending`
`.rule-picker`/`.check-row` pattern) filtered to `people`/`email`/`text`/`long_text` **plus any saved
id**, and migrates `toFromColumn` → `toFromColumns` on edit (same pattern as `status_changed_to` →
`item_column_changed`). `test:polish` +6 (6→12). Verified live: the real patient item resolves its
Patient Email column end-to-end.
  - **Known gap (pre-existing, unchanged):** recipients are resolved at **event time** and baked into
    the queued payload, so a *delayed* email reads the column when the rule fires, not when it sends.
    If the address is filled in after the trigger, the queued send has no recipient and
    `senders/index.ts` logs `[email] skipped — no recipients`.

**Email opt-out gate (2026-07-20):** patients who don't want email contact are now suppressed
service-wide by a **global gate at send time**, not a per-rule condition. `EMAIL_OPTOUT_COLUMN_ID`
names a board column (a Status column with `Yes`/`No` labels — id from `npm run discover`) and
`EMAIL_OPTOUT_BLOCK_VALUE` (default `No`) the one value that blocks; an empty column id disables the
feature entirely. `RulesEngine.dispatch` is the single path for immediate, queued **and** admin
"run now" sends, so the check lives in its `email` branch (`emailOptOutState`, `src/rules/engine.ts`)
and covers all three. Config is injectable via `EngineDeps.emailOptOut` (env is read at module load,
so tests couldn't otherwise set it). `dispatch` gained a third arg `ctx?: DispatchContext`
(`{ itemId?, item? }`) rather than baking an itemId into the email payload — **queue rows written
before this deploy keep working**; the immediate path passes the already-hydrated `item` (no extra
monday call), the worker and admin pass `itemId`.
  - **Why not a rule condition** (the original ask): (a) conditions compare `.text` with strict `===`
    and a missing/empty column reads `''` (`engine.ts:617`), so `email_allowed is equal "Yes"` would
    block mail on every untouched item — "default yes" inverts; (b) a condition is opt-in per rule
    and `shouldFireQueued` only re-checks `item_in_group_for_days` rules, so a `relative` "+48h"
    email already queued would still fire after the flag flips to No. The gate reads the **live**
    value at send time, so that case is covered.
  - **Semantics:** empty/untouched column ⇒ allowed (the manager only marks exceptions); comparison
    is trimmed + case-insensitive (unlike conditions elsewhere — a safety gate must not be defeated
    by `"no "`). A **missing column** (typo'd `EMAIL_OPTOUT_COLUMN_ID`) ⇒ allowed + loud warn, since
    the alternative silently blocks all mail. **Unreadable flag** (hydrate throws/null, or no item
    context) ⇒ **throws** → the worker's existing retry/backoff retries 3× then marks `failed`, so a
    transient monday blip recovers and a persistent one is visible. An explicit opt-out returns
    silently (+warn) and is marked `sent` — retrying can't change the answer.
  - **Scope: email only.** Slack is internal staff notification, not patient contact. _(Superseded
    2026-07-29 — the gate now covers Slack too; see below.)_
  - UI: `GET /api/config` returns the gate config, and the email action editor shows a hint stating
    whether the gate is active and on which column — so nobody re-implements it as a condition.
  - **Unchanged pre-existing gap:** recipient *addresses* are still resolved at arm time and frozen
    into the queued payload (`engine.ts:356`). The gate fixes the consent half; a delayed email whose
    address column changes after arming still uses the old address.

**Suppression is now visible, not silent (2026-07-21):** a withheld email was reported exactly like a
delivered one — the "run now" button toasted success, the queue row read `sent`, and the only trace
was a log line. Cause: `dispatch` returned `void`, so its callers couldn't distinguish "suppressed"
from "delivered". Now `dispatch` returns **`DispatchResult`** (`{ suppressed?: { reason:
'email_opt_out', detail } }`, `src/rules/engine.ts`) and every caller reports it:
  - **Queue:** new terminal status **`suppressed`** (`QueuedStatus`, `src/queue/types.ts`) +
    `store.markSuppressed(id, at, reason)` and a `queued_actions.status_reason` column. It is
    terminal like `sent` (never retried — consent won't change on retry) but distinct. The column is
    added by an idempotent **`ALTER TABLE`** (`addColumnIfMissing`, `src/db/store.ts`) since
    `CREATE TABLE IF NOT EXISTS` is a no-op on the deployed DB; verified against a copy of the real
    `data/automation.sqlite`.
  - **Worker:** counts `suppressed` separately from `sent` in `runDueActions`' return + log line.
  - **Admin "run now":** returns `{ ok: true, suppressed: true, reason }`; the UI shows an amber
    **"Not sent — …"** toast instead of the green success one.
  - **Engine (immediate path):** `HandleResult.suppressed` — a withheld email no longer counts as
    `executed` (nor as `failed`, since it isn't an error).
  - **UI:** amber `SUPPRESSED` badge, an inline 🚫 reason line on the queue row naming the item and
    column, and `suppressed` in the status filter (`web/app.js`, `web/index.html`).
  - Verified live: a queued email for real opted-out item `12552856576` → suppressed with reason,
    while item `11477159468` (flag empty) sent — checked in a real browser.

**Opt-out gate now covers Slack (2026-07-29):** the client asked that an item marked "do not contact"
suppress its **Slack** notifications too, not just email — so the email-only gate became a
**channel-aware contact gate**. `EmailOptOutConfig` → **`ContactOptOutConfig`** (`columnId`,
`blockValue`, **`channels: ('email'|'slack')[]`**), `emailOptOutState` → `contactOptOutState(channel,
ctx)`, and `dispatch`'s **slack branch** now runs the same check as the email branch; the suppression
detail names the channel (`optOutDetail`). `DispatchResult.suppressed` gained `channel` and its
`reason` is now `'contact_opt_out'` (was `'email_opt_out'` — only ever read in-process; queue rows
store the human `detail`, so no migration). `EngineDeps.emailOptOut` → `contactOptOut`.
  - **Env:** `CONTACT_OPTOUT_COLUMN_ID` / `CONTACT_OPTOUT_BLOCK_VALUE`, **falling back to the
    original `EMAIL_OPTOUT_*` names** so the deployed Coolify config keeps working untouched. New
    `CONTACT_OPTOUT_CHANNELS` (default `email,slack`) selects the gated channels — set it to `email`
    to restore the old behavior without a code change.
  - **Worth knowing before this ships:** most live Slack actions are *internal staff* pings
    (`item_in_group_for_days` → slack: "X has sat in Hospital-CPMC for 3 days"), not messages to the
    patient. With Slack gated, an opted-out patient's item stops generating those staff reminders as
    well — that is what was asked for, but if the client only meant patient-facing Slack, the fix is
    `CONTACT_OPTOUT_CHANNELS=email` plus a per-action override (not built).
  - Everything else is unchanged and already channel-agnostic: the worker/admin/immediate paths mark
    a suppressed Slack the same way (queue status `suppressed` + reason, amber badge, `HandleResult
    .suppressed`), and fail-closed-on-unreadable-flag now protects Slack too.
  - UI: `GET /api/config` returns `contactOptOut` (with `channels`); the hint moved to a shared
    `optOutHint(channel)` shown in **both** the email and Slack action editors, and says explicitly
    when a channel is *not* gated.
  - `test:polish` +8 (28→36): slack suppressed / allowed / empty-flag / channel-not-gated, immediate
    counts, queued slack suppressed at send time with a terminal reason.

**Board-wide scope + `move_item_to_group` action (2026-07-29):** the client wanted a **"Move To"**
status column (labels = group titles) that moves an item when a group is picked. No new trigger was
needed — `item_column_changed` already covers any column — but two things were missing: a way to
scope a rule to the whole board, and any ability to move an item.
  - **`scope.allGroups`** (`RuleScope`, `src/rules/types.ts`): `scopeMatches` returns true,
    `ruleScopeMatches` treats it as "any group left" for `item_left_group`, the loader accepts it
    (`scope must set groupId, groupTitleContains or allGroups`), and the configurator's scope combo
    gained a **★ Any group (board-wide)** option (`ANY_GROUP` sentinel in `web/app.js`, mapped to
    `{allGroups:true}` in `buildRule`, reverse-mapped on edit, shown as "Any group" in the rule list;
    the subitem-name picker degrades to free text since there's no single group to read names from).
    Every existing rule still names a group, so nothing changed for them.
  - **`move_item_to_group` action** (`MoveToGroupAction`; `moveItemToGroup`/`GroupMover` in
    `src/monday/write.ts`, injectable on the engine like `columnWriter`): `group` accepts a group id,
    a group **title**, or a template — the intended value is `{{column.<moveToColumnId>}}`. Added to
    `QueuedActionType`, so a delayed move queues like anything else. **Resolution and the
    already-in-that-group guard happen at SEND time**, in one round-trip that reads the board's
    groups and the item's current group together (`MOVE_LOOKUP`), so a scheduled move never acts on
    a stale snapshot. An unresolvable name returns `{moved:false, reason}` + logs — it never throws
    (a bad group name won't fix itself on retry) and never re-fires a group's entry rules by moving
    an item to where it already is. UI: `moveDestControls` — a combo of the board's groups plus
    "↪ the group named in “<column>”" for each status/dropdown/text column.
  - **`set_column` may now be empty** (`src/rules/loader.ts`): an empty value CLEARS the column,
    which the Move To rule needs (see below). Previously the loader rejected it outright.
  - **The rule** (in `config/rules.json` as
    `all-groups--on-move-to-change--move-item-then-clear-column`; renamed 2026-08-01, see §12 —
    it is now **enabled**): scope Any group · trigger `item_column_changed` on Move To
    (any change) · condition **Move To has any value** · actions ① move to `{{column.…}}` ② set
    Move To = ''. The reset makes the column behave like a button — monday emits no event when a
    column is re-set to the value it already holds, so without it you can't send an item to the
    same group twice — and the condition is what stops the reset from re-entering the rule.
    It points at **`color_mm5qym00`** — the Status column created on 2026-07-29 (see §5), which
    replaced the old empty dropdown (since deleted). Enable the rule in the configurator once the
    deployed instance has it.

**Clone rules collapsed 8 → 1 (2026-07-29):** the 8 pure-clone rules were byte-identical apart from
`scope.groupId`, because `clone_template_subitems` already self-selects its template (the Templates
item whose **name appears in the group title**) and no-ops when there's no match — the per-group
scope was never doing the choosing. Replaced by one `all-groups--on-item-enter--clone-template-subitems`
rule (scope `allGroups`; renamed 2026-08-01, see §12); `config/rules.json` went 32 → 26 rules. The
`np-intake--on-item-enter--consult-invite-plus-48h-xray-nudge` rule keeps its own
clone action (it has email/set_column/slack attached and its subitem `set_column` depends on the
clone landing first).
  - **Engine fix this required:** the post-clone re-hydration was a *per-rule* working copy
    (`let curItem = item`), so with two clone rules matching one event the second saw a **pre-clone**
    snapshot, `templateAlreadyApplied` read stale, and it cloned a **second set of subitems**. The
    refresh now also re-points the shared `item` (`engine.ts:186`), so whichever rule clones first
    wins and the other correctly skips — order-independent.
  - **Behavior change to be aware of:** board-wide cloning now also covers 4 groups that had no
    clone rule but DO have a matching template — **HPSM** (template `HPSM`; the group was titled "HPSM" until 2026-07-29), **Calling PCP**,
    **Sample Forms for surgery coordination**, **CPMC Billing Issue Scripting**. Verified by running
    the real matcher against the live board: 13 of 14 non-Templates groups match a template;
    **Unscheduled Intake** matches none and stays a no-op. Narrowing this again would need a
    "group is not X" condition (doesn't exist) — the cheap alternative is to rename or remove those
    template items.
  - Template names must stay specific: matching is substring + first-match-wins, so a template named
    `Intake` would match both *NP Intake* and *Unscheduled Intake*.
  - Verified live (read-only, no mutation): group resolution by title, by id, with sloppy
    casing/whitespace, unknown name, and empty all behave as designed against board `18403436566`;
    the real `move_item_to_group` **mutation is not yet exercised live** — the board's webhooks point
    at the deployed service, so a test move would fire its rules. First real move is the client's.
  - Configurator round-trip verified in a real browser: the saved rule loads into the builder
    (Any group + destination + reset), re-serializes byte-identically, and PUTs successfully.
  - `test:engine` +12 (71→83): board-wide scope matching items in two different groups, destination
    from a column value, the reset write, the no-self-retrigger condition, a group-scoped rule still
    ignoring other groups, delayed move queueing with the destination rendered at event time, and
    the two-clone-rules dedupe.

**All offline suites pass: `npm test` → 189 checks (ingress 10, engine 83, queue 32, polish 36,
cutover 9, admin 7, exchange 12).**

**Configurator:** run `npm run dev` (or `npm start`) and open `http://localhost:<PORT>/`. If
`WEBHOOK_SHARED_SECRET` is set, saving requires `?secret=<value>` on the URL.

_Update this section as phases progress._

---

## 3. Architecture

Pipeline: **ingress → normalizer → rules engine → queue → worker → senders**

- **Runtime:** Node.js + TypeScript (ESM, `NodeNext`). Run with `tsx` in dev, `tsc`→`node` in prod.
- **Ingress:** Fastify HTTP server (Phase 2) — webhook endpoint with monday `challenge` handshake +
  shared-secret verification.
- **Normalizer:** maps sparse monday webhook payloads → canonical internal events (section 4).
  monday payloads are sparse, so it **hydrates** the item via the API before matching rules.
- **Rules engine:** loads enabled rules, matches by board + scope + trigger, evaluates conditions
  (AND), produces actions.
- **Queue (SQLite):** persistent `queued_actions`; the worker dispatches due ones. This is what
  enables scheduled sends, the "N days in group" trigger, and "clear queued actions".
- **Scheduler/worker:** loop polling the queue ~every 60s (node-cron or system cron → `/dispatch`).
  **Not** WP-Cron. Time-based triggers are scheduled at group-entry, not by polling monday.
- **Senders:** email (nodemailer/SMTP) and Slack (incoming webhooks), with `{{placeholder}}`
  templating resolved at send time.
- **monday client:** GraphQL reads to hydrate events and to read board structure
  (boards→groups→columns→labels→subitems) — the source of all IDs for the future configurator UI.

### Persistence schema (SQLite now, portable to Postgres)
- `rules` — rule definition + `enabled`.
- `queued_actions` — `id, item_id, rule_id, action_type, payload_json, due_at,
  status (pending|sent|cancelled|failed), dedupe_key, created_at, sent_at`.
- `item_group_state` — `item_id, board_id, group_id, entered_at` (drives N-days + leave detection).
- `processed_events` — webhook dedupe log (by monday event id).

---

## 4. The agreed rule spec

A rule = one **trigger** + zero-or-more AND **conditions** + one-or-more **actions**.

### Triggers
| id | fires when | type |
|---|---|---|
| `item_entered_group` | item created in / moved into group X | instant |
| `item_left_group` | item moved out of group X | instant |
| `subitem_checked` | a specific subitem's checkbox/status is checked | instant |
| `all_subitems_checked` | fires once when the LAST of `subitemNames[]` reaches `label` (order-independent) | instant |
| `item_column_changed` | any item column changes — to a specific value, or "any change" if no value | instant |
| `item_in_group_for_days` | item has sat in group X for N days | **timed** |

> `status_changed_to` is the legacy status-only trigger — replaced in the UI by `item_column_changed`
> (which subsumes it). The engine still recognizes old `status_changed_to` rules; the configurator
> migrates them to `item_column_changed` on edit.

> Removed (2026-06-17): the `item_moved` (cross-board/workspace) trigger — monday has no board-move
> webhook in `WebhookEventType`, so it could never fire. Dropped from the engine, types,
> normalizer, and UI to keep the surface minimal.

### Conditions (OR of AND groups)
The configurator authors conditions as **Field → Operator → Value** (query-builder):
- **Subject** = _Item column_ · _Subitem_ (a named subitem's status column) · _Item's group_.
- **Operator** (column/subitem) = _is equal_ / _is not equal_ / _has any value_ / _has no value_;
  (group) = _is in_ / _moved from_. A status column is just a column whose value picker shows its
  labels (its hydrated `.text` is the label), so there's no separate "Status is" condition.

Those map onto the engine's condition types (`src/rules/types.ts`): `column_equals` /
`column_not_equals` / `column_empty` / `column_not_empty`, `subitem_checked` / `subitem_not_checked`
(empty ⇒ `label:''`), `in_group`, `moved_from_group` (true when the move's `sourceGroupId` matches —
pairs with `item_entered_group` to catch a specific transition). The engine still **recognizes**
the legacy `status_is` / `status_is_not` (they run unchanged); the builder reverse-maps them to
_Item column · is equal / is not equal_ on edit and re-saves them as `column_equals` /
`column_not_equals`.

Conditions live in **groups**: the rule matches when ANY `conditionGroups[]` group passes (OR), and
within a group ALL conditions must pass (AND). Legacy flat `conditions[]` is honored as a single AND
group. **For `item_in_group_for_days` (timed) rules, conditions are re-evaluated at *fire time*** by
`RulesEngine.shouldFireQueued` (the worker re-hydrates + re-checks before each scheduled send), so a
timed reminder self-skips once its condition stops holding — no cancel rule required.

### Actions
- `email` — `to` (literal list) and/or `toFromColumns` (a list of column ids — see below), `subject`, `body` (rich HTML), `when`. Optional `subitemName` binds `{{subitem.*}}` to a named subitem (any trigger).
- `slack` — `text` (rich HTML → mrkdwn), channel/webhook, `when`. Optional `subitemName` (same as email).
- `clear_pending` — cancel pending scheduled actions for the item. `scope: 'all'` (default) cancels
  every pending action; `scope: 'rules'` with `ruleIds[]` cancels only those rules' actions (so
  overlapping chains don't wipe each other).
- `clone_template_subitems` — clone subitems from the matching Templates item (ported from the former
  PHP cloner).
- `set_column` — write a value back to monday (`change_simple_column_value`): item or a named
  subitem; status uses the label **index**, other columns take text/number/date; supports `when`
  (so a delayed Slack + a status flip can fire together) and `{{templating}}` on the value. The
  free-text value is authored in the rich editor (supports `{{vars}}` + if/else) and HTML is
  flattened to **plain text** on write — used to stash a generated message in a column for manual reuse.
- `move_item_to_group` — move the item to another group (monday `move_item_to_group`). The
  destination is a group id, a group **title**, or a template (`{{column.<id>}}` — a "Move To"
  column whose labels are group titles); it is resolved at **send time**, an unknown name is logged
  and skipped, and a move to the group the item is already in is a no-op. Supports `when`.
- `post_update` — post an item **Update** (monday `create_update`): item or a named subitem; rich HTML
  body posted **verbatim** (not flattened) with no long_text ~2000-char cap; supports `when` scheduling
  and `{{templating}}`. Use this (not `set_column`) to stash a long email a human reads/copies.
- _Reserved for later:_ `create_subitems`.

`when`: `immediate` | `relative` (`+N days/hours/minutes`) | `relative_from_column` (delay = an
item/subitem column's number × a chosen unit, read at event time) | `absolute` (ISO timestamp).

**Message templating** (email body/subject, Slack text, set_column value) supports `{{dotted.paths}}`
plus block conditionals: `{{#if path}}…{{else}}…{{/if}}`, `{{#unless path}}…{{/unless}}`,
`{{#ifEquals path "value"}}…{{/ifEquals}}` (case-insensitive), nestable — and a named-subitem scope
block `{{#subitem "Exact Name"}}…{{/subitem}}` (inside it `{{name}}`/`{{column.<id>}}`/conditionals
refer to that subitem; lets one message describe several subitems) — see `src/util/template.ts`.

### Rule scope
Every rule names either one group (`scope.groupId`), a title substring (`groupTitleContains`), or
**the whole board** (`scope.allGroups` — "★ Any group" in the configurator). Board-wide is for rules
that aren't about a group at all (a Move To column changing, which can happen to an item anywhere)
and for rules that would otherwise be duplicated per group (template cloning, which picks its
template from the group title).

### Behavioral defaults (decided)
1. **N-days** = calendar days, counted from when the item **entered the group** (not creation).
2. **One-shot** by default; optional `repeat_every_days` for recurring nags.
3. On **leave**, auto-clear the item's pending actions; on **re-entry** the counter resets.
4. **Dedupe** true webhook resends (by event id). A genuine re-transition re-fires (Done→In
   Progress→Done fires twice); never re-fires while a value sits unchanged.
5. **Recipients**: literal addresses and/or any number of configurable columns (`toFromColumns`) —
   email/text columns are read directly, a people column resolves via the `users()` lookup. Merged
   and deduped. Resolved at **event time** (baked into the queued payload), not at send time.
6. **Contact consent**: a board-wide opt-out column (`CONTACT_OPTOUT_COLUMN_ID`, or the original
   `EMAIL_OPTOUT_COLUMN_ID`) suppresses notifications for an item at **send time**, ahead of every
   email and Slack action — immediate, scheduled and admin "run now". Empty/untouched ⇒ allowed.
   Rules need no condition for this. `CONTACT_OPTOUT_CHANNELS` (default `email,slack`) picks which
   channels are gated; `set_column` / `post_update` (monday-internal writes) are never gated.

---

## 5. monday.com facts the build must respect

- **Columns are referenced by `id`, not title.** e.g. `text_mm1n5vbd`, `status`. Titles are labels.
- **Status columns store a label index**, not the text — map index ↔ label via column settings.
- **Subitems live on a separate (hidden) subitem board.** "Subitem checked" needs a webhook on that
  board and a subitem→parent-item mapping. **Subitem webhooks arrive with the SUBITEM board's id**,
  not the parent's — so the engine does NOT board-filter `subitem_changed` events up front; it
  hydrates the parent (via `parentItemId`) and matches `rule.boardId === item.boardId` (parent
  board) afterwards.
  - **monday does NOT allow webhooks on a subitems board.** Register `change_subitem_column_value`
    on the PARENT board instead. (Confirmed: registered webhook id `593090188` on `18403436566`.)
  - **Real subitem-change payload (captured 2026-06-11):** `type` is actually `update_column_value`
    (not `change_subitem_column_value`), `boardId` = subitem board, plus `parentItemId`,
    `parentItemBoardId`, `pulseName` (= subitem name), `value.label.text`. Our normalizer classifies
    it as `subitem_changed` via `parentItemId` presence. **Verified live end-to-end:** a real
    subitem→Done change fired the rule and posted to Slack (`matched:1, executed:1`).
- **Webhook payloads are sparse** ("item X column Y changed") → always hydrate via the API. The PHP
  code already does this in `monday_template_cloner_get_item_with_group_and_subitems()`.
- **No native "workspace/board moved" webhook** — `WebhookEventType` has no board-move event, so
  cross-board moves can't be reacted to (the `item_moved` trigger was removed for this reason).
- **monday `challenge` handshake:** the first POST contains `{ "challenge": "..." }`; echo it back.
- monday may **resend** webhooks → dedupe by event id.

### Discovered board reference — "NP - Testing" (board `18403436566`)
_From `npm run discover` on 2026-06-11. Use these IDs when authoring rules / fixtures._

- **Subitem board:** `18403436575` ("Subitems of NP - Testing"). Linked via parent column
  `subtasks_mm1bpggv` (type `subtasks`).
- **Status column** (parent): id `status` — labels: `Working on it`=0, `Done`=1, `Stuck`=2,
  `Scheduled`=5.
- **Subitem Status column:** id `status` — `Working on it`=0, `Done`=1, `Stuck`=2.
  ⚠️ **Subitems have no checkbox** — "subitem checked off" most likely means subitem Status → `Done`.
- **People column:** `person` (parent) / `person` (subitem, titled "Owner") — internal ownership, NOT
  a mailing list (its `.text` is a person's *name*). Selectable as a `toFromColumns` source, but the
  client's real recipients live in **Patient Email** (`email_mm5az59s`, type `email`) and **Referring
  Provider Email** (`text_mm2wm34h`, type `text`).
- **Template-source column** (subitem): `text_mm1n5vbd` (used by the legacy cloner).
- **Groups** (id → title): `group_mm2wbwep`→Unscheduled Intake, `topics`→Templates,
  `group_title`→NP Intake, `group_mm1nrj7r`→HPSM (renamed from "HPSM" 2026-07-29), `group_mm1q43sd`→NP Consultation,
  `group_mm1qxgcp`→On Lok, `group_mm1qzc41`→Calling PCP, plus several office/hospital/post-surgery
  groups. (Re-run `npm run discover` for the full current list.)
- Other notable columns: `date4` (Date), `date_mm2wzc0w` (Last Contacted), `date_mm2w90et`
  (Next Action Date), `color_mm2wt4td` (Lead Status).
- **Move To column:** `color_mm5qym00` ("Move To", type `status`) — **created 2026-07-29 by us via
  the API**. Its 14 labels are the live group titles verbatim (every group except **Templates**),
  index 1–14 in board order; this is what the
  `all-groups--on-move-to-change--move-item-then-clear-column` rule reads. monday cannot
  change a column's type, so this is a NEW column; the old empty `dropdown_mm2wc8hh` (no labels, no
  values on any of the 75 items) was **deleted by the client on 2026-07-29** and no longer exists.
  **If a group is added/renamed later, add/rename the matching label** — the rule matches on title
  text.
- **Email-bearing columns** (recipient sources): `email_mm5az59s` (Patient Email, type `email` —
  added 2026-07), `text_mm2wm34h` (Referring Provider Email, type `text`).
- **Contact opt-out column:** `color_mm5e9gs2` ("Email Allowed", type `status`) — created 2026-07-20.
  Labels: `Yes`=1 (green), `No`=2 (red); **every existing item was left empty**, which the gate reads
  as allowed. Set `CONTACT_OPTOUT_COLUMN_ID=color_mm5e9gs2` (or the legacy `EMAIL_OPTOUT_COLUMN_ID`)
  to activate — since 2026-07-29 it gates **Slack as well as email**, so its title now understates
  what it does (consider renaming it to "Contact Allowed" on the board). Verified live: the column
  hydrates as `{text:"", value:null, type:"status"}` on untouched items → contact allowed.

> Note: the **Templates** group's id is `topics` (not a `group_xxx` slug) — don't assume group ids
> follow one format.

---

## 6. Build phases (non-breaking, incremental)

Early wiring used a **test board**; the former PHP plugin has since been retired (its behavior is
ported into this service).

- **P0 — Scaffolding & handoff** _(in progress)_: project skeleton, env, README, this file.
- **P1 — monday read client + discovery**: GraphQL client + `npm run discover` listing
  boards→groups→columns→labels→subitems.
- **P2 — Ingress + normalizer (log-only)**: Fastify endpoint, challenge + secret verify, normalize
  the 6 events, log only. Point a test-board webhook here.
- **P3 — Rules engine, instant path**: rules store + matcher + conditions; email/slack immediate.
- **P4 — Queue + scheduler**: persistent queue + worker; `when` relative/absolute;
  `item_in_group_for_days`; `clear_pending` + auto-clear on leave.
- **P5 — Recipients & polish**: people-column recipients; templating; dedupe/re-fire; retries.
- **P6 — Cutover**: migrate real board webhooks; optionally fold cloner in; confirm parity; retire PHP.
- **P7 — Configurator UI** _(done)_: dependency-free single-page rule builder + rules API, served by
  the same service; dropdowns fed from `/api/discover`; no manual IDs.

---

## 7. Run & test

```bash
npm install
cp .env.example .env        # set MONDAY_API_TOKEN, board ids, etc.
npm run typecheck           # must pass
npm run discover            # P1: prints a board's structure
npm run dev                 # run the service (ingress + worker)
npm test                    # all offline suites (ingress/engine/queue/polish/cutover)
```

Individual suites: `npm run test:ingress`, `test:engine`, `test:queue`, `test:polish`,
`test:cutover`.

- **Webhook testing (P2+):** point a monday webhook at `http://<host>/webhook?secret=<SECRET>` for a
  **test board**; the prod board keeps flowing to the PHP plugin until P6.
- **Scheduler testing (P4+):** insert a past-due `queued_actions` row → worker sends once & marks
  `sent`; insert a future row then fire a leave event → it flips to `cancelled`.

---

## 8. Security

- The monday API token (PHP line 18) and Slack webhook (PHP line 26) are **committed in plaintext**
  and considered **compromised — rotate both** and keep them only in `.env` (gitignored). Track
  rotation status here: **NOT YET ROTATED.**
- Ingress must verify a **shared secret / signature** (the PHP used `__return_true`, accepting
  anything). `WEBHOOK_SHARED_SECRET` in `.env`.

---

## 9. Glossary

- **Workspace → Board → Group → Item → Subitem → Column** — the monday hierarchy; each has an `id`.
- **Status label** — a named option in a status column, stored internally as an index.
- **Webhook** — monday pushing an event to us instantly (reactive).
- **Scheduler/worker** — our own timer that fires time-based actions (proactive); independent of webhooks.
- **Queued action** — a pending email/Slack send recorded in the DB, possibly with a future `due_at`.

---

## 10. Cutover runbook (Phase 6 — live steps, not yet performed)

Goal: move real traffic from the WordPress plugin to this service with zero gap. Do it on a **test
board first**, then the production board.

**Pre-reqs**
1. Generate a **new** monday API token (the old one is compromised); set `MONDAY_API_TOKEN` in `.env`.
2. Regenerate the **Slack incoming webhook**; set `SLACK_WEBHOOK_URL`.
3. Set `WEBHOOK_SHARED_SECRET` to a random string.
4. Provide SMTP creds (`SMTP_*`) if you want live email (otherwise it stays dry-run/logged).
5. Replace `config/rules.json` with the client's real rules (use `npm run discover` for IDs).

**Stand up the service**
6. Deploy somewhere with a public HTTPS URL (or use a tunnel for testing). `npm ci && npm run build
   && npm start`. Confirm `GET /health` is reachable.
7. Ensure the worker is running (it starts with the server). For extra reliability behind a
   restart, a system cron can `curl` a future dispatch endpoint — but the built-in loop is primary.

**Wire webhooks (test board first)**
8. In monday, add webhooks on the **test board** pointing to
   `https://<host>/webhook?secret=<WEBHOOK_SHARED_SECRET>` for: item created, item moved to group,
   column changed (status), item moved to board. Add the same on the **subitem board** for subitem
   column changes.
9. monday sends a `challenge` on registration — the service echoes it automatically.
10. Exercise each trigger on the test board; confirm Slack/email + scheduled actions behave. Capture
    a few **real** webhook payloads and reconcile `src/monday/normalizer.ts` field names against them
    (the normalizer is defensive but unverified against live payloads — see Phase 2 note).

**Production cutover**
11. Add the same webhooks on the **production board** (`18403436566`) + its subitem board.
12. **Disable the WordPress plugin** (remove/disable `monday-subitem-cloner.php`) so cloning isn't
    duplicated — the `clone_template_subitems` action now covers it.
13. Verify end-to-end: move an item into a configured group → notifications fire + template subitems
    clone; move it out → pending scheduled actions clear.
14. Monitor logs; keep the PHP plugin code around (disabled) for quick rollback until confident.

**Rollback:** re-enable the PHP plugin and remove the new webhooks (or point them away).

---

## 11. Deployment (Docker / Coolify)

The service is one container (`Dockerfile`, multi-stage, `node:24-alpine`, prod deps only;
`node:sqlite` is built into Node so there's no native build). It serves the configurator, the
webhook ingress, and runs the scheduler in-process.

**Data model recap (what persists where):**
- `config/rules.json` (or `RULES_PATH`) — the rules; written by the configurator.
- SQLite (`DATABASE_PATH`) — queue (`queued_actions`), `item_group_state`, `processed_events`.
- In the image both default under **`/app/data`** so a single persistent volume covers everything.

**Coolify steps:**
1. New resource → from this Git repo. Coolify auto-detects the `Dockerfile`.
2. **Environment variables** (Coolify → Environment):
   | var | value |
   |---|---|
   | `MONDAY_API_TOKEN` | a freshly-rotated token |
   | `MONDAY_BOARD_ID` | `18403436566` |
   | `SLACK_WEBHOOK_URL` | the incoming-webhook URL |
   | `WEBHOOK_SHARED_SECRET` | a random string (required — it's public now) |
   | `SMTP_*` | only if you want live email (else dry-run) |
   | `CONTACT_OPTOUT_COLUMN_ID` | `color_mm5e9gs2` (the "Email Allowed" column; blank = gate disabled). The old `EMAIL_OPTOUT_COLUMN_ID` name still works |
   | `CONTACT_OPTOUT_BLOCK_VALUE` | `No` (default) — the value that suppresses contact |
   | `CONTACT_OPTOUT_CHANNELS` | `email,slack` (default) — set to `email` to leave Slack ungated |
   | `PORT` | `3000` (matches the Dockerfile/EXPOSE) |
   `DATABASE_PATH` and `RULES_PATH` are already set to `/app/data/...` in the Dockerfile.
3. **Persistent volume:** mount one at **`/app/data`** (rules + queue survive redeploys). Without
   it, every deploy wipes pending scheduled actions and saved rules.
4. **Single instance** — do NOT scale to >1 replica (the queue has no cross-worker locking → duplicate sends).
5. Set the **domain**; Coolify/Traefik gives HTTPS. Expose port `3000`.
6. Deploy → check `https://<domain>/health`.
7. Open `https://<domain>/` to build rules (the volume's rules.json starts empty). Saving needs
   `?secret=<WEBHOOK_SHARED_SECRET>` appended to the URL.
8. **Register monday webhooks** to `https://<domain>/webhook?secret=<SECRET>` and delete the old
   localtunnel one. Mutations (run against the monday API with the token):
   - register subitem changes: `create_webhook(board_id: 18403436566, url: "https://<domain>/webhook?secret=<SECRET>", event: change_subitem_column_value)`
   - delete the old tunnel webhook: `delete_webhook(id: 593090188)`
   - (add `create_pulse`, `change_column_value`, etc. on the main board for group/status rules)

**Notes:** the worker loop starts with the server (no external cron). `/api/last-events` is a debug
route currently open — gate or remove for production. The in-image `RULES_PATH`/`DATABASE_PATH` point
at the volume, so the bundled `config/rules.json` is NOT used in the container.

---

## 12. Rule ID naming convention (2026-08-01)

Generated IDs were `{group-slug}-{trigger}-{random}` (e.g. `np-intake-item_column_changed-h2bd2`),
which said nothing about what a rule *does* — you had to open each one to find out. All 26 live
rules were renamed to a **self-describing** convention:

> `{group}--{when}--{what}`

Three `--`-separated parts, kebab-case inside each. The group comes first so related rules sort
together in the configurator list. Examples:

- `np-intake--on-status-stuck--reschedule-plus-48h-72h-followup`
- `hospital-cpmc--after-31d--lead-cool-plus-archive-alert`
- `post-surgery--on-second-visit-done--recall-slack-after-delay`

**IDs are opaque to the engine** — `boardId` / `scope` / `trigger` do all the matching, so renaming
is behaviour-neutral. Two things DO read them, and both were updated together:

1. **`clear_pending` with `scope:'rules'`** stores `ruleIds[]` *inside* rules.json — 2 references were
   rewritten (NP Intake scheduled-cancel, NP Consultation treatment-plan-signed-cancel).
2. **`queued_actions.rule_id`** in SQLite. Rows queued under an OLD id still **fire** —
   `shouldFireQueued` returns `true` when the id is not found (`engine.ts:388`), so nothing is
   silently dropped. The one in-flight gap: a scoped `clear_pending` will not match pre-rename
   rows, so an already-queued action can outlive its cancel. Drain the queue before deploying, or
   accept a short overlap.

When adding a rule, keep the convention — the configurator Generate button still emits the old
random form (`generateRuleId()`, `web/app.js`), so rename it by hand.

### Mapping (old → new)

| old | new |
|---|---|
| `any-group-clone-templates` | `all-groups--on-item-enter--clone-template-subitems` |
| `any-group-move-to-column` | `all-groups--on-move-to-change--move-item-then-clear-column` |
| `unscheduled-intake-item_entered_group-cpxpf` | `unscheduled-intake--on-item-enter--thanks-plus-48h-72h-followup` |
| `np-intake-item_entered_group-8hr97` | `np-intake--on-item-enter--consult-invite-plus-48h-xray-nudge` |
| `np-intake-item_column_changed-h2bd2` | `np-intake--on-status-stuck--reschedule-plus-48h-72h-followup` |
| `np-intake-item_column_changed-nv7s0` | `np-intake--on-status-scheduled--cancel-stuck-followups` |
| `np-intake-item_in_group_for_days-tw6ry` | `np-intake--after-31d--lead-cool-plus-archive-alert` |
| `in-office-w-halsey-item_in_group_for_days-uzoap` | `in-office-halsey--after-31d--lead-cool-plus-archive-alert` |
| `in-office-w-lee-item_in_group_for_days-0l2z7` | `in-office-lee--after-31d--lead-cool-plus-archive-alert` |
| `in-office-w-vu-item_in_group_for_days-mkv1r` | `in-office-vu--after-31d--lead-cool-plus-archive-alert` |
| `hospital-cpmc-item_in_group_for_days-ms4nu` | `hospital-cpmc--after-31d--lead-cool-plus-archive-alert` |
| `hospital-kaiser-item_in_group_for_days-dxakh` | `hospital-kaiser--after-31d--lead-cool-plus-archive-alert` |
| `post-surgery-item_in_group_for_days-ibiww` | `post-surgery--after-31d--lead-cool-plus-archive-alert` |
| `np-consultation-item_in_group_for_days-49hae` | `np-consultation--after-7d--missing-docs-email-plus-1w-3w-alerts` |
| `np-consultation-subitem-set-ah2cu` | `np-consultation--on-treatment-plan-signed--cancel-missing-docs-chase` |
| `in-office-w-halsey-in-group-days-1p7er` | `in-office-halsey--after-7d--missing-docs-update-plus-1w-3w-alerts` |
| `in-office-w-lee-in-group-days-wccbz` | `in-office-lee--after-7d--missing-docs-update-plus-1w-3w-alerts` |
| `in-office-w-vu-in-group-days-ehx6e` | `in-office-vu--after-7d--missing-docs-update-plus-1w-3w-alerts` |
| `hospital-cpmc-in-group-days-yxscu` | `hospital-cpmc--after-7d--missing-docs-update-plus-1w-3w-alerts` |
| `hospital-kaiser-in-group-days-2mi4x` | `hospital-kaiser--after-7d--missing-docs-update-plus-1w-3w-alerts` |
| `in-office-w-halsey-subitem-set-vpa9s` | `in-office-halsey--on-welcome-email-done--surgery-outline-update` |
| `in-office-w-lee-subitem-set-kbhoz` | `in-office-lee--on-welcome-email-done--surgery-outline-update` |
| `in-office-w-vu-subitem-set-p3zvm` | `in-office-vu--on-welcome-email-done--surgery-outline-update` |
| `hospital-cpmc-subitem-set-6gowk` | `hospital-cpmc--on-welcome-email-done--surgery-outline-update` |
| `hospital-kaiser-subitem-set-hagpy` | `hospital-kaiser--on-welcome-email-done--surgery-outline-update` |
| `post-surgery-subitem-set-wnzr6` | `post-surgery--on-second-visit-done--recall-slack-after-delay` |

The rename was a one-shot script (not committed). `config/rules.live.json` is an untracked snapshot
of the **pre-rename** live ruleset, and `config/rules.json.bak` the local pre-rename backup.
