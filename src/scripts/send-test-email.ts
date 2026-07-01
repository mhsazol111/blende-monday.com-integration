/**
 * Send a single test email through the real configured transport (Graph/SMTP/
 * dry-run, per EMAIL_PROVIDER + .env) to verify email credentials end-to-end.
 *
 *   npm run test:email                 # sends to the default address below
 *   npm run test:email you@example.com # sends to a given address
 *
 * NOT part of `npm test` — it makes a live send.
 */
import { defaultSenders } from '../senders/index.js';

const to = process.argv[2] || 'you@example.com';

async function main() {
  console.log(`Sending test email to ${to} ...`);
  await defaultSenders.sendEmail({
    to: [to],
    subject: 'Test email from Blende Monday Automation',
    body: 'This is a plain-text test email sent via the configured SMTP transport (Titan). If you received this, the SMTP credentials work.',
    html: '<p>This is a <strong>test email</strong> sent via the configured SMTP transport (Titan).</p><p>If you received this, the SMTP credentials work. ✅</p>',
  });
  console.log('Done — sendEmail() resolved without throwing.');
}

main().catch((err) => {
  console.error('sendEmail() failed:');
  console.error(err);
  process.exit(1);
});
