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

**History:** the original proof-of-concept is `monday-subitem-cloner.php`, a WordPress plugin that
(a) clones template subitems on item create/move and (b) fires one hardcoded Slack+email when an
item enters one group. Everything in it is hardcoded. WordPress was only a fast test host; we are
moving to a standalone service. **The PHP plugin stays live in production until Phase 6 cutover** —
do not break it.

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
  - Live-verified read path: prod board `18403436566` already has 3 of the 4 managed events
    (`create_item`, `item_moved_to_any_group`, `change_subitem_column_value`) from earlier project
    testing — these are pre-existing, NOT created by this feature; only `change_column_value` is
    missing. **Registration not run on prod** (PHP plugin still live; localhost can't register).

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
`ConditionContext`. Catches a specific transition (e.g. NP Intake → New HPSM) reliably, even on a
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

**Generated Rule IDs include the group (2026-06-24):** the configurator's "Generate" button now
produces `{group-slug}-{trigger}-{random}` (was `{trigger}-{random}`) so the rule list shows which
group a rule targets. `generateRuleId()` slugifies the selected group's title (`web/app.js`); falls
back to `{trigger}-{random}` when no group is picked. UI-only; server treats IDs as opaque.

**All offline suites pass: `npm test` → 124 checks (ingress 10, engine 56, queue 24, polish 6,
cutover 9, admin 7, exchange 12).** The legacy PHP plugin is still untouched and live.

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
`subitem_checked` ("Subitem is" — a named subitem's status equals a label, incl. `''` = empty) ·
`status_is` / `status_is_not` · `column_equals` / `column_empty` / `column_not_empty` · `in_group` ·
`moved_from_group` (true when the move's `sourceGroupId` matches — pairs with `item_entered_group` to
catch a specific transition).

Conditions live in **groups**: the rule matches when ANY `conditionGroups[]` group passes (OR), and
within a group ALL conditions must pass (AND). Legacy flat `conditions[]` is honored as a single AND
group.

### Actions
- `email` — `to` (literal list) and/or `to_from_column` (people/email column), `subject`, `body` (rich HTML), `when`. Optional `subitemName` binds `{{subitem.*}}` to a named subitem (any trigger).
- `slack` — `text` (rich HTML → mrkdwn), channel/webhook, `when`. Optional `subitemName` (same as email).
- `clear_pending` — cancel all pending scheduled actions for the item.
- `clone_template_subitems` — clone subitems from the matching Templates item (ported PHP cloner).
- `set_column` — write a value back to monday (`change_simple_column_value`): item or a named
  subitem; status uses the label **index**, other columns take text/number/date; supports `when`
  (so a delayed Slack + a status flip can fire together) and `{{templating}}` on the value. The
  free-text value is authored in the rich editor (supports `{{vars}}` + if/else) and HTML is
  flattened to **plain text** on write — used to stash a generated message in a column for manual reuse.
- _Reserved for later:_ `post_update`, `create_subitems`.

`when`: `immediate` | `relative` (`+N days/hours/minutes`) | `relative_from_column` (delay = an
item/subitem column's number × a chosen unit, read at event time) | `absolute` (ISO timestamp).

**Message templating** (email body/subject, Slack text, set_column value) supports `{{dotted.paths}}`
plus block conditionals: `{{#if path}}…{{else}}…{{/if}}`, `{{#unless path}}…{{/unless}}`,
`{{#ifEquals path "value"}}…{{/ifEquals}}` (case-insensitive), nestable — see `src/util/template.ts`.

### Behavioral defaults (decided)
1. **N-days** = calendar days, counted from when the item **entered the group** (not creation).
2. **One-shot** by default; optional `repeat_every_days` for recurring nags.
3. On **leave**, auto-clear the item's pending actions; on **re-entry** the counter resets.
4. **Dedupe** true webhook resends (by event id). A genuine re-transition re-fires (Done→In
   Progress→Done fires twice); never re-fires while a value sits unchanged.
5. **Recipients**: literal addresses and/or a configurable people column (e.g. assignee),
   resolved to emails at send time.

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
- **People column:** `person` (parent) / `person` (subitem, titled "Owner") — recipient source for
  `to_from_column`.
- **Template-source column** (subitem): `text_mm1n5vbd` (used by the legacy cloner).
- **Groups** (id → title): `group_mm2wbwep`→Unscheduled Intake, `topics`→Templates,
  `group_title`→NP Intake, `group_mm1nrj7r`→New HPSM, `group_mm1q43sd`→NP Consultation,
  `group_mm1qxgcp`→On Lok, `group_mm1qzc41`→Calling PCP, plus several office/hospital/post-surgery
  groups. (Re-run `npm run discover` for the full current list.)
- Other notable columns: `date4` (Date), `date_mm2wzc0w` (Last Contacted), `date_mm2w90et`
  (Next Action Date), `color_mm2wt4td` (Lead Status), `dropdown_mm2wc8hh` (Move To).

> Note: the **Templates** group's id is `topics` (not a `group_xxx` slug) — don't assume group ids
> follow one format.

---

## 6. Build phases (non-breaking, incremental)

The PHP plugin stays live; all wiring uses a **test board** until Phase 6.

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
