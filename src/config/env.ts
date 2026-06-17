import 'dotenv/config';

/**
 * Centralised environment access. Values are read lazily so a command only
 * fails on the variables it actually needs (e.g. the discovery script needs
 * MONDAY_API_TOKEN but not SMTP_*).
 */

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

/** Read a required variable, throwing a clear error if it is missing. */
export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        `Copy .env.example to .env and set it.`,
    );
  }
  return value;
}

export const env = {
  // monday
  get mondayApiToken() {
    return required('MONDAY_API_TOKEN');
  },
  mondayApiUrl: optional('MONDAY_API_URL', 'https://api.monday.com/v2'),
  mondayBoardId: optional('MONDAY_BOARD_ID'),
  mondayTestBoardId: optional('MONDAY_TEST_BOARD_ID'),

  // server
  port: Number(optional('PORT', '3000')),
  webhookSharedSecret: optional('WEBHOOK_SHARED_SECRET'),
  /** Public HTTPS base URL monday should call (e.g. https://blende-monday.mhsazol.me).
   *  Used to build the webhook registration URL. If unset, the admin API derives
   *  it from the incoming request's host/proto headers. */
  publicUrl: optional('PUBLIC_URL'),

  // persistence
  databasePath: optional('DATABASE_PATH', './data/automation.sqlite'),

  // rules
  rulesPath: optional('RULES_PATH', './config/rules.json'),

  // scheduler
  workerIntervalMs: Number(optional('WORKER_INTERVAL_MS', '60000')),
  workerMaxAttempts: Number(optional('WORKER_MAX_ATTEMPTS', '3')),
  workerRetryBackoffMs: Number(optional('WORKER_RETRY_BACKOFF_MS', '300000')), // 5 min × attempt

  // slack
  slackWebhookUrl: optional('SLACK_WEBHOOK_URL'),

  // email
  smtpHost: optional('SMTP_HOST'),
  smtpPort: Number(optional('SMTP_PORT', '587')),
  smtpUser: optional('SMTP_USER'),
  smtpPass: optional('SMTP_PASS'),
  smtpFromName: optional('SMTP_FROM_NAME', 'Monday Automation'),
  smtpFromEmail: optional('SMTP_FROM_EMAIL', 'no-reply@example.com'),

  // logging
  logLevel: optional('LOG_LEVEL', 'info'),
};
