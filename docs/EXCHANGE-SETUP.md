# Sending email through Microsoft 365 / Exchange — what we need from you

> **Audience:** the client's Microsoft 365 / IT administrator.
> **Goal:** let our monday.com automation service send notification emails *from your
> organization's mailbox* (e.g. `notifications@yourcompany.com`) reliably and securely.

We use **Microsoft Graph** with **app-only OAuth** — Microsoft's recommended method. This means
**we never need a mailbox password.** Instead, you create a small "App Registration" in your
Microsoft tenant and grant it permission to send mail. You can revoke it at any time, and you can
restrict it to a single mailbox.

This takes about **10–15 minutes** for an admin. Below are step-by-step instructions, followed by
the **5 values to send back to us**.

---

## What you'll create

An **App Registration** in Microsoft Entra ID (formerly Azure Active Directory) with the
**`Mail.Send` application permission**. That's it — no servers, no licenses beyond the one mailbox
you already have for sending.

---

## Step-by-step (admin)

### 1. Create the App Registration
1. Go to **https://entra.microsoft.com** (or the Azure Portal → **Microsoft Entra ID**).
2. In the left menu: **App registrations** → **+ New registration**.
3. **Name:** `monday-automation-mailer` (any name is fine).
4. **Supported account types:** choose **"Accounts in this organizational directory only"**.
5. Leave **Redirect URI** blank. Click **Register**.
6. On the app's **Overview** page, copy these two values — you'll send them to us:
   - **Application (client) ID**
   - **Directory (tenant) ID**

### 2. Create a client secret
1. In the app, go to **Certificates & secrets** → **Client secrets** → **+ New client secret**.
2. **Description:** `monday-automation`. **Expires:** choose 12 or 24 months (longest your policy
   allows — see "Secret expiry" note below).
3. Click **Add**.
4. **Immediately copy the secret's `Value`** (not the "Secret ID"). It is shown **only once** — if
   you navigate away you'll have to create a new one. Send us this value.

### 3. Grant the Mail.Send permission
1. In the app, go to **API permissions** → **+ Add a permission**.
2. Choose **Microsoft Graph** → **Application permissions** (NOT "Delegated permissions").
3. Search for and select **`Mail.Send`**. Click **Add permissions**.
4. Back on the API permissions list, click **"Grant admin consent for <your org>"** and confirm.
   The `Mail.Send` row should then show a green **"Granted"** status.

   > ⚠️ This step requires a Global Administrator. Without admin consent, sending will fail.

### 4. Pick the sending mailbox
Decide which address the automated emails should come **from** — e.g.
`notifications@yourcompany.com` or `automation@yourcompany.com`.

- It must be a **real, licensed mailbox** (or a shared mailbox) in your tenant.
- A dedicated mailbox (rather than a person's) is recommended.
- Tell us this address.

### 5. (Recommended) Restrict the app to just that mailbox
By default, the `Mail.Send` application permission lets the app send as **any** user in your tenant.
We recommend locking it down to only the sending mailbox using an **Application Access Policy**.

Your admin can run this in **Exchange Online PowerShell** (replace the values):

```powershell
# Optional but recommended — limits the app to ONE mailbox.
New-ApplicationAccessPolicy `
  -AppId "<the Application (client) ID from step 1>" `
  -PolicyScopeGroupId "notifications@yourcompany.com" `
  -AccessRight RestrictAccess `
  -Description "Restrict monday automation mailer to the notifications mailbox"
```

(If you'd rather scope it to a mail-enabled security group of mailboxes, point
`-PolicyScopeGroupId` at that group instead.) This step is optional — skipping it does not stop
email from working; it only widens what the app *could* do.

---

## What to send back to us

Please send these **5 items** (the secret value is sensitive — use a secure channel such as a
password manager share, not plain email if possible):

| # | Item | Where it came from | Example |
|---|------|--------------------|---------|
| 1 | **Directory (tenant) ID** | App Overview page | `8f3c…-…-…` |
| 2 | **Application (client) ID** | App Overview page | `1a2b…-…-…` |
| 3 | **Client secret value** | Certificates & secrets (step 2) | `abc7Q~…` |
| 4 | **Sending mailbox address** | the address chosen in step 4 | `notifications@yourcompany.com` |
| 5 | **Confirmation** that `Mail.Send` (Application) was added **and admin-consented** | step 3 | "Done ✅" |

Once we have these, we plug them into the service's configuration and send a test email — nothing
further is needed from your side.

---

## A couple of important notes

- **Secret expiry:** the client secret you created **expires** on the date you chose. When it
  nears expiry, an admin must create a **new** secret (step 2) and send us the new value, or
  automated emails will stop. We'll remind you ahead of time; please also note the expiry date on
  your end.
- **Exchange Online vs on-prem:** these instructions assume **Microsoft 365 / Exchange Online**
  (cloud). If your email is hosted on an **on-premises Exchange Server** instead, Graph does not
  apply — let us know and we'll switch to an SMTP-based setup (we'd then need an SMTP host,
  port, and a mailbox username/password instead).
- **Security:** we store the secret only in the service's private configuration, never in code or
  in monday. You can revoke our access instantly at any time by deleting the client secret (or the
  whole App Registration) in Entra ID.

---

## FAQ

**Do we have to give you a password?** No. App-only OAuth uses a client secret tied to a
permission you control — not anyone's mailbox password.

**Can the app read our email?** No. We request **only** `Mail.Send` (send-only). It cannot read,
delete, or list mail.

**Can we limit which addresses it sends from?** Yes — see step 5 (Application Access Policy).

**How do we turn it off?** Delete the client secret or the App Registration in Entra ID. Sending
stops immediately.
