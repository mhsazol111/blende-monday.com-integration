import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

/**
 * HTTP Basic Auth for the configurator (admin UI + its API).
 *
 * Everything is protected by default — the carve-out list below is the only way
 * in without credentials — so a route added later is closed the moment it
 * exists. That's the inverse of the per-route opt-in this replaced, under which
 * every read route (`/api/rules`, `/api/queue`, `/api/discover`,
 * `/api/last-events`) was silently public.
 *
 * The browser does all the frontend work: a 401 + `WWW-Authenticate` on the
 * top-level document load makes it prompt natively, then it attaches the
 * `Authorization` header to every same-origin request afterwards — including
 * the `fetch()` calls in web/app.js, which needed no changes.
 */

const REALM = 'Blende automation configurator';

/**
 * Paths reachable WITHOUT credentials:
 *  - /webhook — monday sends no `Authorization` header and can't be taught to.
 *    It authenticates with its own `?secret=` (checked in server.ts) and must
 *    stay open or every automation silently dies behind a login prompt.
 *  - /health  — Coolify/Traefik healthchecks, same reason.
 */
const PUBLIC_PATHS = new Set(['/webhook', '/health']);

export function isPublicPath(url: string): boolean {
  return PUBLIC_PATHS.has(url.split('?')[0]);
}

/** Compare via fixed-length digests so neither the result nor the length leaks through timing. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseBasicAuth(header?: string): { user: string; pass: string } | null {
  if (!header) return null;
  const [scheme, encoded] = header.split(' ');
  if (!encoded || scheme?.toLowerCase() !== 'basic') return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':'); // a password may itself contain ':'
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

/** True when the request carries the configured admin username + password. */
export function basicAuthOk(header?: string): boolean {
  const creds = parseBasicAuth(header);
  if (!creds) return false;
  // Both compared unconditionally — no early return on a wrong username.
  const userOk = safeEqual(creds.user, env.adminUser);
  const passOk = safeEqual(creds.pass, env.adminPassword);
  return userOk && passOk;
}

/**
 * The pre-existing admin credential: `?secret=` / `x-webhook-secret` matching
 * WEBHOOK_SHARED_SECRET. Still accepted so bookmarked `?secret=` configurator
 * links and any curl-based scripting keep working — it already gated every
 * write, so honouring it here grants nothing it didn't already grant.
 */
export function sharedSecretOk(req: { query: unknown; headers: Record<string, unknown> }): boolean {
  const expected = env.webhookSharedSecret;
  if (!expected) return false;
  const fromQuery = (req.query as { secret?: string } | undefined)?.secret;
  return fromQuery === expected || req.headers['x-webhook-secret'] === expected;
}

/** Either credential is sufficient. Used by the hook and by the write-route gate. */
export function adminAuthorized(req: { query: unknown; headers: Record<string, unknown> }): boolean {
  return basicAuthOk(req.headers.authorization as string | undefined) || sharedSecretOk(req);
}

// Shown when the user cancels the prompt or gets the password wrong — otherwise
// the browser renders a blank page and it looks like the service is broken.
const UNAUTHORIZED_HTML = `<!doctype html><meta charset="utf-8">
<title>Sign in required</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1.5rem;color:#323338}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#676879;margin:0}</style>
<h1>Sign in required</h1>
<p>The automation configurator needs a username and password. Reload the page to try again.</p>`;

export function registerBasicAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isPublicPath(request.url)) return;
    if (adminAuthorized(request)) return;

    reply
      .code(401)
      .header('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
      .type('text/html')
      .send(UNAUTHORIZED_HTML);
    return reply; // halt the lifecycle — nothing else runs for this request
  });
}
