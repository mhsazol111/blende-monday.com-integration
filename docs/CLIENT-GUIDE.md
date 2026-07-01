# Your monday automations — plain-English guide

This guide explains how your automated notifications work, what each of your automations
does, and — most importantly — **how to figure out why something isn't firing** when you
expect it to. No technical background needed.

---

## How an automation works

Every automation is built from four simple parts:

1. **WHEN** — the moment that starts it. For example: *an item enters a group*, *a status
   changes*, *a subitem is marked Done*, or *an item has been sitting in a group for N
   days*.
2. **ONLY IF** *(optional)* — a condition that must be true, otherwise nothing happens.
   For example: *only if the treatment plan subitem is not yet Done*.
3. **DO** — what happens: send an email, post a Slack message, set a value on the item or
   a subitem, or clear other pending reminders.
4. **WHEN TO DO IT** — each action can happen **right away** or **later** (e.g. "after 2
   days"). Later actions wait until their time comes.

A single automation can have several actions with different timings — that's how a
"drip" works (email now, Slack in 2 days, another email in 3 days).

### Two things that surprise people

- **Reminders that wait, then check again.** For time-based automations ("after N days in
  a group"), each waiting reminder **re-checks its condition at the moment it's due**. So a
  reminder chain "not signed → nag" will **quietly stop itself** as soon as the patient
  signs — you don't need a separate "cancel" automation.
- **Delays add up from the N-day mark.** On a "7 days in group" automation, an action set
  to "after 7 days" actually sends on **day 14** (7 + 7), and "after 14 days" on **day
  21**. That's how "one week, then another week, then another week" is built.

---

## Your automations at a glance

1. **Unscheduled Intake — welcome drip.** When a patient enters *Unscheduled Intake*: send
   a welcome email now, a Slack after 2 days, and another email after 3 days. If the
   patient leaves the group, the not-yet-sent messages are cancelled automatically.

2. **NP Intake — welcome + x-ray nudge.** When a patient enters *NP Intake*: send the
   welcome email, mark the "welcome email" subitem as done, and Slack a request for
   x-rays after 2 days.

3. **NP Intake — went Unscheduled ("abandoned cart").** When a patient's status changes to
   *Unscheduled*: send an email now, a Slack after 2 days, and an email after ~5 days. If
   the patient is re-scheduled (status → *Scheduled*), this chain is cancelled.

4. **Clone template subitems.** When a patient enters a group, copy in that group's
   template checklist (subitems).

5. **Stale in a bucket — cool down + archive.** When a patient has been in a bucket
   (NP Intake, In-office w/ Lee or Vu, Hospital CPMC or Kaiser, Post-Surgery) for **more
   than a month**: set their Lead Status and Slack the coordinator to archive them.

6. **NP Consultation — plan not signed.** One week after entering *NP Consultation*, if the
   treatment-plan subitem still isn't Done: a call reminder, then an email a week later,
   then a phone-call reminder a week after that. Each step is skipped if the plan is signed
   by then.

7. **NP Consultation — treatment not booked.** Same one-week cadence, but for a patient who
   hasn't booked treatment yet. Each step is skipped once the booking subitem is Done.

---

## Creating & managing automations

You build and edit automations in the configurator — the web tool we set up for you.

**The basics**
1. Open the tool's link in your browser. Your board loads automatically.
2. There are three tabs: **Rules** (your automations), **Scheduled actions** (messages
   waiting to be sent), and **Board & connect**.
3. On **Rules**, click **New rule** to start one, or **edit** on an existing one to change
   it.
4. Fill in the four parts (below) and click **Save rule** — it takes effect immediately.
5. **One-time setup:** on **Board & connect**, click **Connect this board** so the tool
   receives events from monday. You only do this once.

**Filling in a rule**
- **Trigger (WHEN)** — choose from the dropdown: *Item entered the group*, *Item left the
  group*, *Item column changed to* (a column such as Status changes — optionally to a
  specific value), *Subitem set (status →)* (a named subitem reaches a status like Done),
  or *Item in group for N days*.
- **Group** — pick which group this automation watches (by name).
- **Conditions (ONLY IF)** *(optional)* — add a row and choose a **Subject** (Item column,
  Subitem, or Item's group), a **Condition** (*is equal*, *is not equal*, *has any value*,
  *has no value*), and a **Value**. The value box becomes a dropdown when the column has
  set choices (like a status).
- **Actions (DO)** — add one or more: *Send email*, *Send Slack*, *Set a monday value*,
  *Clear pending actions*, or *Clone template subitems*. Each action has a timing:
  **immediately** or **after a delay** (days / hours / minutes).

**Editing, deleting, and checking what's waiting**
- **Edit** an automation with its edit button; **delete** it with its delete button.
- The **Scheduled actions** tab lists every message still waiting to send — you can send it
  now, reschedule it, or delete it there.

---

## Step-by-step: building each automation

> You pick groups, columns, and subitems **by name** from dropdowns — you never type any
> codes or IDs.

### Rule 1 — Unscheduled Intake welcome drip
1. New rule → Trigger **Item entered the group** → Group **Unscheduled Intake**.
2. Actions:
   - **Send email** (welcome) → **immediately**
   - **Send Slack** → **after a delay** → **2 days**
   - **Send email** → **after a delay** → **3 days**
3. Save. No cancel step needed — leaving the group cancels the waiting messages.

### Rule 2 — NP Intake welcome + x-ray nudge
1. New rule → Trigger **Item entered the group** → Group **NP Intake**.
2. Actions:
   - **Send email** (welcome) → **immediately**
   - **Set a monday value** → Target **Subitem** → the welcome-email subitem → Status **Done** → **immediately**
   - **Send Slack** (request x-rays) → **after a delay** → **2 days**
3. Save. If subitems are added when patients enter, put a **Clone template subitems**
   action *before* the "Set a monday value" step.

### Rule 3 — NP Intake "went Unscheduled" drip (two automations)
**Part A — the drip**
1. New rule → Trigger **Item column changed to** → Column **Status** → Fires on **A
   specific value** → **Unscheduled** → Group **NP Intake**.
2. Actions:
   - **Send email** → **immediately**
   - **Send Slack** → **after a delay** → **2 days**
   - **Send email** → **after a delay** → **5 days**
3. Save.

**Part B — stop it when re-scheduled**
1. New rule → Trigger **Item column changed to** → Column **Status** → **A specific value**
   → **Scheduled** → Group **NP Intake**.
2. Action: **Clear pending actions** → **Only specific rules** → tick **Part A above**.
3. Save.

### Rule 4 — Clone template subitems on entry
For each group that should clone: New rule → Trigger **Item entered the group** → the
group → Action **Clone template subitems** → Save. One automation per group.

### Rule 5 — Stale-in-bucket cool-down (one per bucket)
1. New rule → Trigger **Item in group for N days** → **30** days → Group = the bucket.
2. Actions:
   - **Set a monday value** → Target **Item** → **Lead Status** → **Cold** → **immediately**
   - **Send Slack** (coordinator: archive) → **immediately**
3. Save, then repeat for each bucket: **NP Intake, In-office w/ Lee, In-office w/ Vu,
   Hospital - CPMC, Hospital - Kaiser, Post-Surgery**.

### Rule 6 — NP Consultation: plan not signed
1. New rule → Trigger **Item in group for N days** → **7** days → Group **NP Consultation**.
2. Condition: Subject **Subitem** → the treatment-plan subitem → Status → **is not equal**
   → **Done**.
3. Actions:
   - **Send Slack** (call reminder) → **immediately** (day 7)
   - **Send email** → **after a delay** → **7 days** (day 14)
   - **Send Slack** (phone call) → **after a delay** → **14 days** (day 21)
4. Save. Each step is skipped automatically if the plan is signed by then.

### Rule 7 — NP Consultation: treatment not booked
Build it exactly like Rule 6, with two differences:
- **Condition:** Subject **Subitem** → the **booking** subitem → Status → **is not equal**
  → **Done**.
- The third action is the "phone call **with doctor**" reminder.

---

## Why isn't my automation working?

Work down this list — most issues are one of these.

### "I created the automation but existing patients didn't get anything."
Automations only act on things that happen **after** you create them. An item has to
**enter the group** (or the change has to happen) *after* the automation exists. For a
"days in group" automation, move the patient out and back in to start it fresh.

### "The reminder didn't stop even though the patient signed / booked."
The reminder re-checks its condition when it's due, and it only stops if the condition
matches **exactly**:
- The **right subitem** — the subitem name in the automation must match the subitem on the
  item exactly.
- The **right status** — e.g. the automation looks for exactly **Done**. If the subitem is
  "Working on it" or a differently-named label, it won't count as signed/booked.

Open the item, confirm the subitem name and that its status is exactly the label the
automation expects.

### "Nothing fires at all — no email, no Slack."
- **Is the board connected?** Automations need your monday board connected to receive
  events. If it was never connected (or was disconnected), triggers won't fire.
- **Status-change automations need the column connection specifically.** If a "when status
  changes to X" automation does nothing, the board may be missing that connection — ask
  us to enable it.
- **Does the value exist on your board?** A trigger set to "status becomes *Canceled*"
  never fires if your board has no *Canceled* label. The label must exist and be spelled
  the same.

### "The 'set a value' action didn't change anything."
- The value you're setting (for example a **Cool** Lead Status) must **already exist as a
  label** on that column. If the label isn't on the board yet, monday has nothing to set —
  add the label first.
- If you're setting a **subitem's** value, that subitem must already exist on the item. If
  subitems get added when the patient enters the group, make sure the "add subitems" step
  runs first.

### "The reminder came at the wrong time."
For "days in group" automations, delays are added **on top of** the N-day mark. "After 7
days" on a 7-day automation means day 14, not day 7.

### "I cancelled one reminder and it cancelled others too."
"Clear pending actions" can either clear **everything** waiting for that patient, or **only
specific automations**. If it cleared too much, switch it to "only specific rules" and pick
just the chain you meant to stop.

### "The message shows old/wrong information."
For scheduled (later) messages, the text is prepared **when the patient enters the group**,
so it reflects their details at that moment — not the moment the message is finally sent.

### "The email/Slack went out but to nobody / the wrong person."
If recipients come from a **People column** (like an assignee), that column has to have
someone assigned on the item. An empty People column means no recipient.

### "The same reminder came twice."
Check that you don't have two automations doing the same thing on the same group.

---

## What needs to exist on your monday board

Some automations depend on labels or subitems being present. If one of these is missing,
the related automation can't work until it's added:

| For | Needs on the board | Right now |
|---|---|---|
| "Went Unscheduled" (Rule 3) | an **Unscheduled** status label | ✅ present |
| Re-scheduled cancel (Rule 3) | a **Scheduled** status label | ✅ present |
| Plan-not-signed / not-booked (Rules 6 & 7) | the treatment-plan and booking **subitems**, reaching **Done** | ✅ subitems use Done — confirm their names |
| Welcome-email tracking (Rule 2) | a **welcome-email subitem** | ✅ tracked as a subitem — confirm its name |
| Stale-in-bucket cool-down (Rule 5) | a Lead Status label to set | Using **Cold** now; add **Cool** later to switch to it |

---

## Still stuck?

If an automation still isn't behaving after checking the above, note **which patient**,
**which automation**, and **what you expected vs. what happened**, and send it over — that's
usually enough to pinpoint it quickly.
