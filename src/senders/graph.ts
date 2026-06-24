import type { EmailMessage } from './index.js';

/**
 * Microsoft Graph email transport (Exchange Online / Microsoft 365).
 *
 * Uses the OAuth2 *client-credentials* (app-only) flow against an Azure AD app
 * registration that has been granted the `Mail.Send` **application** permission
 * (with admin consent). No mailbox password is involved — this is the path
 * Microsoft recommends now that Basic-Auth SMTP is being disabled on M365.
 *
 * Implemented with the built-in global `fetch` (Node 22+) so we add no new
 * npm dependency. `fetchImpl` is injectable so tests can run fully offline.
 */

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Mailbox/UPN to send from, e.g. notifications@client.com */
  sender: string;
}

type FetchLike = typeof fetch;

/** Module-level token cache, keyed by tenant+client so swapping creds re-auths. */
let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

/** Acquire (and cache) an app-only access token for Microsoft Graph. */
async function getAccessToken(cfg: GraphConfig, fetchImpl: FetchLike): Promise<string> {
  const key = `${cfg.tenantId}:${cfg.clientId}`;
  const now = Date.now();
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Graph token request failed (HTTP ${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error('Graph token response missing access_token.');
  }

  // Refresh ~60s before actual expiry to avoid edge-of-expiry failures.
  const ttlMs = (json.expires_in ?? 3600) * 1000;
  tokenCache = { key, token: json.access_token, expiresAt: now + ttlMs - 60_000 };
  return json.access_token;
}

/** Send one email via the Graph `sendMail` endpoint. Throws on any non-2xx. */
export async function sendViaGraph(
  msg: EmailMessage,
  cfg: GraphConfig,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const token = await getAccessToken(cfg, fetchImpl);

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`;
  const payload = {
    message: {
      subject: msg.subject,
      body: {
        contentType: msg.html ? 'HTML' : 'Text',
        content: msg.html ?? msg.body,
      },
      toRecipients: msg.to.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: false,
  };

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Graph sendMail failed (HTTP ${res.status}): ${detail}`);
  }
}

/** Test-only: reset the cached token (used by the offline suite). */
export function __resetGraphTokenCache(): void {
  tokenCache = null;
}
