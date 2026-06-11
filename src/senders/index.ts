import { env } from '../config/env.js';
import { log } from '../util/logger.js';

/** Outbound notification senders. Injectable so tests can capture calls. */
export interface EmailMessage {
  to: string[];
  subject: string;
  body: string;
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
 * Default senders.
 *  - Email: real SMTP via nodemailer when SMTP_HOST is configured; otherwise
 *    DRY-RUN (logged). nodemailer is imported lazily so it's only loaded when used.
 *  - Slack: live POST to the incoming-webhook URL; dry-run if none configured.
 */
export const defaultSenders: Senders = {
  async sendEmail(msg) {
    if (msg.to.length === 0) {
      log.warn(`[email] skipped — no recipients (subject="${msg.subject}").`);
      return;
    }
    if (!env.smtpHost) {
      log.info(`[email DRY-RUN] to=${msg.to.join(', ')} subject="${msg.subject}"`, msg.body);
      return;
    }
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
    });
    log.info(`[email] sent to ${msg.to.join(', ')} — "${msg.subject}".`);
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
