# Automation rules — build guide

How to configure the client's automations in the configurator UI. This is the technical
reference (control names, board IDs, exact steps). For a plain-language version to share
with the client, see **[CLIENT-GUIDE.md](./CLIENT-GUIDE.md)**.

Board: **NP - Testing** (`18403436566`). Facts below are from `npm run discover`
(2026-07-01).

---

## 1. Getting started

1. Open the configurator at `https://<domain>/`. If `WEBHOOK_SHARED_SECRET` is set,
   append `?secret=<value>` — saving fails without it.
2. The board loads automatically on the **Rules** tab.
3. **Board & connect** tab → **Connect this board** registers the monday webhooks that
   deliver live events. Without it, triggers never fire (see §5).
4. Build a rule with **New rule**, fill in Trigger / Scope / Conditions / Actions, then
   **Save rule** (it validates, saves, and reloads immediately).

---

## 2. Anatomy of a rule

Every rule is: **WHEN** (trigger) + **scope** (one group) + **only if** (conditions) +
**do** (actions, each with its own timing).

### Triggers

| Trigger dropdown | Fires when |
|---|---|
| **Item entered the group** | an item is created in, or moved into, the scoped group |
| **Item left the group** | an item moves out of the scoped group |
| **Item column changed to** | a column changes — to any value, or to a specific value |
| **Subitem set (status →)** | a named subitem's status reaches a chosen label |
| **All of these subitems set (any order)** | the last of several named subitems reaches the label |
| **Item in group for N days** | an item has sat in the group for N days (time-based) |

### Conditions — a **Subject → Condition → Value** row

| Control | Options |
|---|---|
| **Subject** | `Item column` · `Subitem` · `Item's group` |
| **Condition** | column/subitem: `is equal` · `is not equal` · `has any value` · `has no value` — group: `is in` · `moved from` |
| **Value** | a **label dropdown** for status/dropdown columns, a **text field** otherwise, and **hidden** for the has-value operators |

A status column is just an Item column whose value picker lists its labels. Multiple
conditions are AND within a group; add a **"+ OR group"** for OR-of-ANDs.

### Actions

| Action dropdown | Does |
|---|---|
| **Send email** | subject + rich body; recipients as literal addresses and/or a People column |
| **Send Slack** | rich message to the default webhook or a per-action one |
| **Set a monday value (item/subitem)** | writes a column on the item or a named subitem |
| **Clear pending actions** | cancels queued actions — **All**, or **Only specific rules** |
| **Clone template subitems** | copies the matching Templates item's subitems onto the item |

### Timing (the `when` on each action)

`immediately` · `after a delay` (Days / Hours / Minutes) · `after a delay from a column
value` · `at a specific time`.

---

## 3. How timing and conditions behave

- **A rule only reacts to future events.** An item must enter the group, or the change
  must happen, *after* the rule exists. Items already sitting in a group get nothing until
  they leave and re-enter.
- **"Item in group for N days" is time-based.** It starts counting when the item enters
  the group. Leaving the group cancels its pending reminders; re-entering restarts the
  clock.
- **Conditions on a timed rule are checked when each reminder is due**, against the item's
  live state. If the condition no longer holds, that reminder is skipped. This is how a
  chain "stops itself" once a patient signs or books — no separate cancel rule needed.
- **Delays stack on the N-day mark.** On a 7-day rule, an action set to `after a delay of
  7 days` fires on day 14, and `14 days` on day 21.
- **Clear pending actions** cancels every queued action for the item, or only the ones
  from chosen rules (**Only specific rules**). Use the scoped form to avoid wiping
  unrelated chains — see §7.
- **A rule targets one group.** There's no "all groups" option — repeat the rule per
  group.
- **"Item column changed to" matches the new value only** — it can't require a specific
  previous value. (Only group *moves* can, via the `moved from` condition.)
- **Scheduled messages are composed when the item enters the group**, so `{{variables}}`
  reflect the state at that moment, not at send time. For a clone→message rule, place the
  message **after** the clone so it sees the new subitems.

---

## 4. Board reference (from discovery)

**Groups** — Unscheduled Intake `group_mm2wbwep` · NP Intake `group_title` · New HPSM
`group_mm1nrj7r` · NP Consultation `group_mm1q43sd` · On Lok `group_mm1qxgcp` · Calling
PCP `group_mm1qzc41` · In-office w/ Halsey `group_mm1q5y2h` · In-office w/ Lee
`group_mm1qkfsj` · In-office w/ Vu `group_mm1qbqpv` · Hospital - CPMC `group_mm1qt38e` ·
Hospital - Kaiser `group_mm1q2dcd` · Post-Surgery `group_mm1q34g` · Templates `topics`.

**Item `status` labels** — Working on it (0) · Done (1) · Stuck (2) · **Unscheduled** (3)
· **Scheduled** (5).

**Lead Status** (`color_mm2wt4td`) labels — **Cold** (1). *(No "Cool" yet — see Rule 5.)*

**Subitem board** `18403436575` — `status` labels Working on it (0) · **Done** (1) · Stuck
(2); template-source column `text_mm1n5vbd`.

**People column** for recipients — `person`.

> Rules 2, 6, 7 reference specific subitems by name. The subitem picker lists real subitem
> names in the group — confirm the exact names there when building.

---

## 5. Webhooks per trigger

Registered from **Board & connect → Connect this board**.

| Trigger | Needs webhook |
|---|---|
| Item entered / left the group | `create_item` + `item_moved_to_any_group` |
| Item column changed to | `change_column_value` |
| Subitem set / All subitems set | `change_subitem_column_value` |
| Item in group for N days | none (time-based, runs in the service) |

> The prod board already has `create_item`, `item_moved_to_any_group`, and
> `change_subitem_column_value`, but **not** `change_column_value`. Register it before
> relying on **Rule 3** (a column-changed trigger).

---

## 6. The rules

### Rule 1 — Unscheduled Intake: welcome drip
Enter the group → email now, Slack at 48h, email at 72h. Cancels itself if the item leaves.

- **Trigger:** Item entered the group · **Scope:** Unscheduled Intake (`group_mm2wbwep`)
- **Actions:** ① Send email (email A) `immediately` · ② Send Slack (notif A) `after 48 Hours` · ③ Send email (email B) `after 72 Hours`
- No cancel rule — leaving the group auto-clears the pending 48h/72h sends.

### Rule 2 — NP Intake: welcome + x-ray nudge
Enter the group → welcome email, mark the welcome-email subitem done, Slack at 48h.

- **Trigger:** Item entered the group · **Scope:** NP Intake (`group_title`)
- **Actions:** ① Send email (email 1) `immediately` · ② Set a monday value → Target **Subitem** → the welcome-email subitem → Status = **Done** `immediately` · ③ Send Slack (notif B, request x-rays) `after 48 Hours`
- The subitem must exist on the item first. If subitems are cloned on entry, put a **Clone
  template subitems** action before ②.

### Rule 3 — NP Intake: "Unscheduled" abandoned-cart drip
Status → Unscheduled → email now, Slack at 48h, email at 120h. Stops if status → Scheduled.

**3a — the drip**
- **Trigger:** Item column changed to → Column **Status** → Fires on **A specific value** → **Unscheduled** · **Scope:** NP Intake
- **Actions:** ① Send email (email C) `immediately` · ② Send Slack (notif C) `after 48 Hours` · ③ Send email (email B) `after 120 Hours` *(48 + 72 — see note)*
- Needs the `change_column_value` webhook (§5).
- *"72h after that" reading:* 72h after the Slack = 120h from the trigger. For 72h from the
  trigger instead, use `72 Hours`.

**3b — stop on re-schedule**
- **Trigger:** Item column changed to → Column **Status** → Fires on **A specific value** → **Scheduled** · **Scope:** NP Intake
- **Action:** Clear pending actions → **Only specific rules → Rule 3a** (leaves Rules 2 & 5 untouched).

### Rule 4 — Clone templates on entry (per group)
Enter the group → clone its template subitems.

- **Trigger:** Item entered the group · **Scope:** the group · **Action:** Clone template subitems
- One rule per group (no "all groups"). Cloning acts only where a matching Templates item exists.

### Rule 5 — Stale in bucket → cool-down + archive nudge (per bucket)
In a bucket > 1 month → set Lead Status and Slack the coordinator to archive.

- **Trigger:** Item in group for N days → **30** · **Scope:** the bucket group
- **Actions:** ① Set a monday value → Item → **Lead Status** = **Cold** `immediately` · ② Send Slack (coordinator) `immediately`
- Uses **Cold** for now; switch to **Cool** once that label is added to Lead Status.
- **One rule per bucket:** NP Intake `group_title` · In-office w/ Lee `group_mm1qkfsj` ·
  In-office w/ Vu `group_mm1qbqpv` · Hospital - CPMC `group_mm1qt38e` · Hospital - Kaiser
  `group_mm1q2dcd` · Post-Surgery `group_mm1q34g`.

### Rule 6 — NP Consultation: treatment plan not signed
1 week in the group and plan not signed → call reminder, +1wk email, +1wk phone-call.

- **Trigger:** Item in group for N days → **7** · **Scope:** NP Consultation (`group_mm1q43sd`)
- **Condition:** Subject **Subitem** → the treatment-plan subitem → Status → **is not equal** → **Done**
- **Actions:** ① Send Slack (notif E, call) `immediately` (day 7) · ② Send email (email 2) `after 7 Days` (day 14) · ③ Send Slack (notif F, phone) `after 14 Days` (day 21)
- Each step is skipped if the subitem is **Done** by the time it's due — no cancel rule.

### Rule 7 — NP Consultation: treatment not booked
1 week in the group and not booked → call reminder, +1wk email, +1wk phone-call w/ doctor.

- **Trigger:** Item in group for N days → **7** · **Scope:** NP Consultation (`group_mm1q43sd`)
- **Condition:** Subject **Subitem** → the booking subitem → Status → **is not equal** → **Done** *(booking is tracked on a subitem, like Rule 6)*
- **Actions:** ① Send Slack (call) `immediately` (day 7) · ② Send email `after 7 Days` (day 14) · ③ Send Slack (phone w/ doctor) `after 14 Days` (day 21)
- Each step is skipped once the booking subitem is **Done**.

---

## 7. Overlaps to keep in mind

- **NP Consultation (Rules 6 & 7)** run on the same items — an item gets both chains (6
  reminders). Each step carries its own condition and re-checks it when due, so signing
  the plan silences only Rule 6 and booking silences only Rule 7. They don't cross-cancel.
- **NP Intake (Rules 2, 3, 5)** share the group. Rule 3b uses **Clear pending → Only
  specific rules → Rule 3a**, so re-scheduling cancels only the abandoned-cart chain and
  leaves Rule 2's and Rule 5's pending sends alone. ("All pending actions" would wipe them
  too.)
- **Leaving a group already cancels** that item's pending actions, so "cancel by leaving"
  needs no rule. For in-place changes, prefer a **condition on the timed rule** (self-skip)
  and use **Clear pending → specific rules** only when a *different* event should stop a
  chain.
- **Cloning (Rule 4)** — don't add two clone rules for the same group.
