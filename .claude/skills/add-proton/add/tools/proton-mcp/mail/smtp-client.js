/**
 * SMTP client for Proton Bridge
 * Handles send and reply operations via nodemailer
 */

import nodemailer from 'nodemailer';
import { getMessageHeaders } from './imap-client.js';

function createTransporter(config) {
  return nodemailer.createTransport({
    host: config.smtp_host || '127.0.0.1',
    port: config.smtp_port || 1025,
    secure: false,
    auth: {
      user: config.username,
      pass: config.password,
    },
    tls: { rejectUnauthorized: false },
  });
}

export async function sendMessage(config, { to, subject, body, cc, bcc, attachments }) {
  const transporter = createTransporter(config);

  const info = await transporter.sendMail({
    from: config.username,
    to,
    cc,
    bcc,
    subject,
    text: body,
    attachments,
  });

  return { success: true, message_id: info.messageId };
}

export async function replyMessage(config, { originalMessageId, body, cc, attachments }) {
  const headers = await getMessageHeaders(config, originalMessageId);

  const replySubject = headers.subject.startsWith('Re:')
    ? headers.subject
    : `Re: ${headers.subject}`;

  // Build References chain: existing refs + original Message-ID
  const refsList = [...(headers.references || []), headers.messageId].filter(Boolean);
  const referencesStr = refsList.join(' ');

  const transporter = createTransporter(config);

  const info = await transporter.sendMail({
    from: config.username,
    to: headers.from, // reply to the original sender
    cc,
    subject: replySubject,
    text: body,
    inReplyTo: headers.messageId,
    references: referencesStr,
    attachments,
  });

  return { success: true, message_id: info.messageId };
}
