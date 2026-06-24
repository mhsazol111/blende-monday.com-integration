import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { sendViaGraph } from './graph.js';

/** Outbound notification senders. Injectable so tests can capture calls. */
export interface EmailMessage {
  to: string[];
  subject: string;
  /** Plain-text body (always present — the fallback for non-HTML clients). */
  body: string;
  /** Optional HTML body (rich-text rules). Sent alongside `body`. */
  html?: string;
}

export interface SlackMessage {
  webhookUrl: string;
  text: string;
}

export interface Senders {
  sendEmail(msg: EmailMessage): Promise<void>;
  sendSlack(msg: SlackMessage): Promise<void>;
}

/**
 * Resolve which email transport to use.
 *  - `EMAIL_PROVIDER=graph|smtp` forces a transport.
 *  - `auto` (default): Graph if its creds are present, else SMTP if SMTP_HOST is
 *    set, else dry-run.
 */
function resolveEmailProvider(): 'graph' | 'smtp' | 'dry-run' {
  const choice = (env.emailProvider || 'auto').toLowerCase();
  if (choice === 'graph') return 'graph';
  if (choice === 'smtp') return 'smtp';
  // auto
  if (env.msGraphClientId) return 'graph';
  if (env.smtpHost) return 'smtp';
  return 'dry-run';
}

/**
 * Default senders.
 *  - Email: Microsoft Graph (Exchange Online) or SMTP via nodemailer, selected by
 *    EMAIL_PROVIDER / auto-detect; DRY-RUN (logged) when nothing is configured.
 *    nodemailer is imported lazily so it's only loaded when SMTP is used.
 *  - Slack: live POST to the incoming-webhook URL; dry-run if none configured.
 */
export const defaultSenders: Senders = {
  async sendEmail(msg) {
    if (msg.to.length === 0) {
      log.warn(`[email] skipped — no recipients (subject="${msg.subject}").`);
      return;
    }

    const provider = resolveEmailProvider();

    if (provider === 'dry-run') {
      log.info(`[email DRY-RUN] to=${msg.to.join(', ')} subject="${msg.subject}"`, msg.body);
      return;
    }

    if (provider === 'graph') {
      await sendViaGraph(msg, {
        tenantId: env.msGraphTenantId,
        clientId: env.msGraphClientId,
        clientSecret: env.msGraphClientSecret,
        sender: env.msGraphSender,
      });
      log.info(`[email] sent via Graph to ${msg.to.join(', ')} — "${msg.subject}".`);
      return;
    }

    // provider === 'smtp'
    const { createTransport } = await import('nodemailer');
    const transport = createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
    });
    await transport.sendMail({
      from: `${env.smtpFromName} <${env.smtpFromEmail}>`,
      to: msg.to.join(', '),
      subject: msg.subject,
      text: msg.body,
      ...(msg.html ? { html: msg.html } : {}),
    });
    log.info(`[email] sent via SMTP to ${msg.to.join(', ')} — "${msg.subject}".`);
  },

  async sendSlack(msg) {
    const url = msg.webhookUrl || env.slackWebhookUrl;
    if (!url) {
      log.info(`[slack DRY-RUN] (no webhook configured) text="${msg.text}"`);
      return;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg.text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Slack webhook HTTP ${res.status}: ${detail}`);
    }
    log.info(`[slack] sent: "${msg.text}"`);
  },
};
