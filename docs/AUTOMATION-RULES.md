# Automation rules — build guide

Step-by-step instructions for creating the client's 7 automation rules in the
configurator UI. **No code** — just what to click. Assumes you know the pipeline
in `CLAUDE.md`.

---

## 0. Before you start

1. Open the configurator: `https://<domain>/` (append `?secret=<WEBHOOK_SHARED_SECRET>`
   if that env var is set — saving fails without it).
2. On the **Rules** tab the board auto-loads. If not, load board `18403436566`
   ("NP - Testing").
3. Each rule below = **Rules → New rule**, fill in Trigger / Scope / Conditions /
   Actions, then **Save rule** (validates + saves + hot-reloads the engine).
4. Make sure the board's monday webhooks are registered (**Board & connect** tab →
   "Connect this board"). Without them, no live events arrive.

### Builder legend (the user's words → the control to use)

| You want… | Trigger dropdown | Notes |
|---|---|---|
| "when an item enters group X" | **Item entered the group** | pick group in Scope |
| "when an item leaves group X" | **Item left the group** | |
| "when status becomes Y" | **Item column changed to** | Column = Status, value = Y |
| "when subitem is Done" | **Subitem set (status →)** | pick subitem + Done |
| "after N days sitting in the group" | **Item in group for N days** | timed; armed at entry |

| You want… | Action dropdown |
|---|---|
| Slack notification | **Send Slack** |
| Email | **Send email** |
| Tick a monday field / flip a status | **Set a monday value (item/subitem)** |
| Stop all queued reminders for the item | **Clear pending actions** |
| Copy template subitems in | **Clone template subitems** |

**Timing of an action** (the `when` dropdown on each action):
`immediately` · `after a delay` (Days/Hours/Minutes) · `after a delay from a column
value` · `at a specific time`.

---

## ⚠️ Read this first — behaviors that shape every rule below

These are engine facts (verified in `src/rules/engine.ts`) that change how you must
build the rules:

1. **"Item in group for N days" now honors Conditions — at fire time.** The timed
   trigger still *arms* on group entry (scope only), but each reminder **re-checks the
   rule's Conditions when it comes due**, re-reading the item live. If the condition no
   longer holds (patient signed / booked), the reminder **self-skips**. So "remind
   unless signed/booked" is a **condition on the timed rule** — no separate cancel rule
   needed. (Fire-time re-check applies to timed rules only.)
2. **Delays stack on the N-days base.** For a timed rule, an action's `when` layers
   on top of the N-days mark. To get "at 1 week, then +1 week, then +1 week" you set
   the three actions to `immediately`, `after a delay 7 days`, `after a delay 14 days`
   (7 → 14 → 21 days total). Each fires only if the condition still holds at that time.
3. **"Clear pending actions" can be scoped.** Choose **All pending actions** (cancels
   every queued action for the item — the legacy behavior) or **Only specific rules**
   (cancels just the chosen rules' queued actions). Use the scoped form for cross-rule
   cancels so overlapping chains don't wipe each other — see **Overlaps** at the bottom.
4. **Leaving the group auto-cancels** that item's pending actions. So "cancel by
   leaving" needs no rule — it's automatic. Re-entering re-arms and resets the clock.
5. **Timed rules only arm on a fresh entry.** Items already sitting in a group when
   you create the rule won't get reminders until they leave and re-enter. Same for
   entry/column triggers — they fire on future events only.
6. **A rule must be scoped to one group.** There is no "all groups" wildcard in the
   builder, so "all groups" rules = one rule per group.
7. **Column-change triggers match the NEW value only** — they can't require a
   specific previous value (only group *moves* can, via "moved from group").
8. **Timed payloads render at arm time** — `{{...}}` variables capture the item's
   state at group entry, not a week later.

---

## Rule 1 — Unscheduled Intake: welcome drip

> Enter Unscheduled Intake → email A now, Slack A at 48h, email B at 72h. Cancel by
> leaving.

- **Trigger:** Item entered the group
- **Scope:** group **Unscheduled Intake**
- **Conditions:** none
- **Actions:**
  1. **Send email** — email A — `when = immediately`
  2. **Send Slack** — notification A — `when = after a delay → 48 Hours` (or 2 Days)
  3. **Send email** — email B — `when = after a delay → 72 Hours` (or 3 Days)
- **Cancel:** none needed — moving the item out of the group auto-clears actions 2 & 3.

---

## Rule 2 — NP Intake: welcome + x-ray nudge

> Enter NP Intake → welcome email now, tick the "welcome email sent" field, Slack B
> at 48h. No cancel.

- **Trigger:** Item entered the group
- **Scope:** group **NP Intake**
- **Conditions:** none
- **Actions:**
  1. **Send email** — email 1 (welcome) — `when = immediately`
  2. **Set a monday value** — Target **Item**, pick the "welcome email sent" column,
     set its value (for a status/checkbox column choose the label) — `when = immediately`
  3. **Send Slack** — notification B (request x-rays) — `when = after a delay → 48 Hours`
- **Cancel:** none.
- **Note:** if the item leaves NP Intake before 48h, action 3 auto-cancels (item 4
  above) — usually fine.

---

## Rule 3 — NP Intake: "Canceled" abandoned-cart drip

> Status becomes **Canceled** → email C now, Slack C at 48h, email B 72h after that.
> Cancel when status becomes **Scheduled**.

Two rules.

**Rule 3a — the drip**
- **Trigger:** Item column changed to → Column **Status**, value **Canceled**
- **Scope:** group **NP Intake**
- **Actions:**
  1. **Send email** — email C — `when = immediately`
  2. **Send Slack** — notification C — `when = after a delay → 48 Hours`
  3. **Send email** — email B — `when = after a delay → 120 Hours` *(48 + 72 — see note)*
- **Note on "72h after that":** I read it as 72h **after the Slack**, i.e. 120h from
  the trigger. If you meant 72h from the trigger instead, use `72 Hours`.
- **Note:** the trigger fires whenever Status becomes Canceled regardless of the
  previous status — the engine can't require "was Scheduled" for a column change.

**Rule 3b — cancel on re-schedule**
- **Trigger:** Item column changed to → Column **Status**, value **Scheduled**
- **Scope:** group **NP Intake**
- **Actions:** **Clear pending actions → Only specific rules → Rule 3a** (so it cancels
  only the abandoned-cart drip, not Rule 2's x-ray Slack or Rule 5's 1-month reminder).
- **⚠️ Overlap (if you use "All pending actions" instead):** it clears *all* pending for
  the item — including Rule 2's 48h Slack
  and Rule 5's 1-month reminder if they're still queued. See Overlaps.

---

## Rule 4 — Clone templates on entry (per group)

> When an item enters a group, clone its template subitems.

- **Trigger:** Item entered the group
- **Scope:** the group
- **Conditions:** none
- **Actions:** **Clone template subitems**
- **⚠️ No "all groups" wildcard** — create **one copy of this rule per group** that
  should clone. Cloning only does something where a matching Templates item exists.
- **Note:** this replaces the retired PHP cloner (its logic now lives in the service),
  so there's no double-clone risk — just don't add two clone rules for the same group.

---

## Rule 5 — Stale-in-bucket → cool + archive nudge (per bucket)

> Patient in a bucket > 1 month → set Lead Status = **Cool** and Slack the coordinator
> to archive.

- **Trigger:** Item in group for N days → **30** days *(leave "Repeat every" blank)*
- **Scope:** the bucket group
- **Conditions:** none (none needed here — the 1-month mark alone is the trigger)
- **Actions:**
  1. **Set a monday value** — Target **Item**, Column **Lead Status** (`color_mm2wt4td`),
     value = label **Cool** — `when = immediately` (fires at the 30-day mark)
  2. **Send Slack** — coordinator, "archive this patient" — `when = immediately`
- **Buckets → make one rule each** (same settings, different Scope): **NP Intake**,
  **In-office w/ Lee**, **In-office w/ Vu**, **Hospital - CPMC**, **Hospital - Kaiser**,
  **Post-Surgery**. (6 rules.)
- **Notes:** "Repeat every N days" is left blank — recurring repeat isn't wired in the
  engine yet, so treat this as one-shot. Confirm the Lead Status column has a label
  literally named **Cool** (distinct from Cold).

---

## Rule 6 — NP Consultation: treatment plan not signed

> 1 week in NP Consultation and plan not signed → reminder-to-call, then email, then
> phone-call. Each step self-cancels once the plan subitem is signed.

**One rule** (no separate cancel rule — the condition gates each send at fire time).
- **Trigger:** Item in group for N days → **7** days
- **Scope:** group **NP Consultation**
- **Conditions:** Subject **Subitem** → the treatment-plan subitem, field **Status**,
  operator **is not equal**, value **Done**
- **Actions:**
  1. **Send Slack** — notification E (reminder to call) — `when = immediately` (day 7)
  2. **Send email** — email 2 — `when = after a delay → 7 Days` (day 14)
  3. **Send Slack** — notification F (phone call) — `when = after a delay → 14 Days` (day 21)
- **How the cancel works:** at day 7/14/21 the worker re-reads the subitem; if it's now
  **Done**, that step is skipped. No cancel rule, and it doesn't touch any other chain.

---

## Rule 7 — NP Consultation: treatment not booked

> 1 week in NP Consultation and treatment not booked → reminder-to-call, then email,
> then phone-call-with-doctor. Each step self-cancels once status is Treatment Scheduled.

**One rule.**
- **Trigger:** Item in group for N days → **7** days
- **Scope:** group **NP Consultation**
- **Conditions:** Subject **Item column** → field **Status**, operator **is not equal**,
  value **Treatment Scheduled**
- **Actions:**
  1. **Send Slack** — reminder to call — `when = immediately` (day 7)
  2. **Send email** — email — `when = after a delay → 7 Days` (day 14)
  3. **Send Slack** — phone call with doctor — `when = after a delay → 14 Days` (day 21)
- Each step fires only while status is still not Treatment Scheduled. *(The original
  "cancel if … status not changed to treatment scheduled" reads as a typo — the intent
  is: stop reminding once it **is** Treatment Scheduled.)*

---

## ⚠️ Overlaps & conflicts to keep in mind

Two mechanisms now keep overlapping chains from interfering — use the right one:

1. **NP Consultation (Rules 6 & 7 share a group and items).** Both arm on entry, so an
   item gets **6** queued actions. Each step carries its **own condition** (6 = "plan not
   signed", 7 = "status not Treatment Scheduled") and re-checks it at fire time, so
   signing the plan silences only Rule 6 and booking silences only Rule 7 — they no
   longer cross-cancel. No cancel rules involved.

2. **NP Intake (Rules 2, 3, 5 share the group).** Rule 3b uses **Clear pending → Only
   specific rules → Rule 3a**, so re-scheduling cancels only the abandoned-cart drip and
   leaves Rule 2's x-ray Slack and Rule 5's 1-month reminder intact. (Choosing "All
   pending actions" would wipe those too — only do that if that's genuinely what you
   want.)

3. **Leaving a group already cancels** — you don't need cancel rules for "cancel by
   leaving" (Rule 1). For in-place state changes, prefer a **condition on the timed
   rule** (self-skip) and reach for **Clear pending → specific rules** only when the
   cancel is triggered by a *different* event than the chain's own condition.

4. **Cloning (Rule 4)** — the legacy PHP cloner is retired and its logic is fully in
   this service, so there's no double-clone risk; just don't add two clone rules for the
   same group.
