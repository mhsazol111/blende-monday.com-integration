/**
 * Send a single test email through the real configured transport (Graph/SMTP/
 * dry-run, per EMAIL_PROVIDER + .env) to verify email credentials end-to-end.
 *
 *   npm run test:email you@example.com # sends to the given address
 *   TEST_EMAIL_TO=you@example.com npm run test:email
 *
 * NOT part of `npm test` — it makes a live send.
 */
import { defaultSenders } from '../senders/index.js';

const to: string = process.argv[2] || process.env.TEST_EMAIL_TO || '';
if (!to) throw new Error('Usage: npm run test:email <recipient>  (or set TEST_EMAIL_TO)');

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
