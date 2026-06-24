import assert from 'node:assert';
import { sendViaGraph, __resetGraphTokenCache, type GraphConfig } from '../senders/graph.js';
import type { EmailMessage } from '../senders/index.js';

/**
 * Exchange (Microsoft Graph) transport verification — fully offline.
 * Injects a fake `fetch` that records requests and returns a token then a 202.
 * Run: `npm run test:exchange`.
 */

let passed = 0;
const check = (name: string, cond: boolean) => {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
};

const cfg: GraphConfig = {
  tenantId: 'tenant-123',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  sender: 'notifications@client.com',
};

type Call = { url: string; init: RequestInit };

/** Build a fake fetch: token endpoint → token JSON; sendMail → given status. */
function makeFetch(opts: { sendStatus?: number; expiresIn?: number } = {}) {
  const calls: Call[] = [];
  let tokenCalls = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    if (u.includes('login.microsoftonline.com')) {
      tokenCalls++;
      return new Response(
        JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: opts.expiresIn ?? 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // sendMail
    return new Response('', { status: opts.sendStatus ?? 202 });
  }) as unknown as typeof fetch;
  return { impl, calls, tokenCalls: () => tokenCalls };
}

async function main() {
  // 1) Happy path: HTML message → token fetched + sendMail shaped correctly.
  {
    __resetGraphTokenCache();
    const { impl, calls } = makeFetch();
    const msg: EmailMessage = {
      to: ['a@x.com', 'b@x.com'],
      subject: 'Hello',
      body: 'plain fallback',
      html: '<p>rich</p>',
    };
    await sendViaGraph(msg, cfg, impl);

    const tokenCall = calls.find((c) => c.url.includes('login.microsoftonline.com'))!;
    const sendCall = calls.find((c) => c.url.includes('graph.microsoft.com'))!;

    check('token endpoint hit with tenant id', tokenCall.url.includes('tenant-123'));
    check(
      'token request uses client_credentials',
      String(tokenCall.init.body).includes('grant_type=client_credentials') &&
        String(tokenCall.init.body).includes('client_id=client-abc'),
    );
    check('sendMail URL targets the sender mailbox', sendCall.url.includes('notifications%40client.com'));
    check(
      'sendMail carries Bearer token',
      (sendCall.init.headers as Record<string, string>).Authorization === 'Bearer tok-1',
    );

    const payload = JSON.parse(String(sendCall.init.body));
    check('contentType is HTML when html present', payload.message.body.contentType === 'HTML');
    check('content is the html body', payload.message.body.content === '<p>rich</p>');
    check(
      'recipients mapped to Graph shape',
      payload.message.toRecipients.length === 2 &&
        payload.message.toRecipients[0].emailAddress.address === 'a@x.com',
    );
    check('saveToSentItems false', payload.saveToSentItems === false);
  }

  // 2) Plain-text message → contentType Text.
  {
    __resetGraphTokenCache();
    const { impl, calls } = makeFetch();
    await sendViaGraph({ to: ['c@x.com'], subject: 's', body: 'just text' }, cfg, impl);
    const sendCall = calls.find((c) => c.url.includes('graph.microsoft.com'))!;
    const payload = JSON.parse(String(sendCall.init.body));
    check('contentType is Text when no html', payload.message.body.contentType === 'Text');
    check('content is the text body', payload.message.body.content === 'just text');
  }

  // 3) Non-2xx sendMail → throws.
  {
    __resetGraphTokenCache();
    const { impl } = makeFetch({ sendStatus: 403 });
    let threw = false;
    try {
      await sendViaGraph({ to: ['d@x.com'], subject: 's', body: 'b' }, cfg, impl);
    } catch {
      threw = true;
    }
    check('non-2xx sendMail throws (so worker retries)', threw);
  }

  // 4) Token is cached across sends (only one token call for two sends).
  {
    __resetGraphTokenCache();
    const fetcher = makeFetch();
    await sendViaGraph({ to: ['e@x.com'], subject: 's', body: 'b' }, cfg, fetcher.impl);
    await sendViaGraph({ to: ['f@x.com'], subject: 's', body: 'b' }, cfg, fetcher.impl);
    check('token reused on second send (cached)', fetcher.tokenCalls() === 1);
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nExchange test failed:', err?.message ?? err);
  process.exitCode = 1;
});
