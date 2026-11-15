/**
 * SMTP client wrapper for sending iCloud Mail
 */

const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const crypto = require('crypto');
const config = require('../config');
const { getCredentials } = require('../auth');

/**
 * Create SMTP transporter
 */
function createTransporter() {
  const creds = getCredentials();

  return nodemailer.createTransport({
    host: config.SMTP.HOST,
    port: config.SMTP.PORT,
    secure: config.SMTP.SECURE,
    auth: {
      user: creds.email,
      pass: creds.password
    }
  });
}

/**
 * Build the raw RFC822 message for a mail (Bcc kept, for the Sent copy).
 */
function buildRaw(mailOptions) {
  return new Promise((resolve, reject) => {
    const node = new MailComposer(mailOptions).compile();
    node.keepBcc = true;
    node.build((err, raw) => (err ? reject(err) : resolve(raw)));
  });
}

/**
 * Send an email
 */
async function sendEmail({ to, cc, bcc, subject, body, isHtml = false }) {
  const creds = getCredentials();
  const transporter = createTransporter();

  const mailOptions = {
    from: creds.email,
    to,
    subject,
    messageId: `<${crypto.randomUUID()}@${creds.email.split('@')[1]}>`,
    [isHtml ? 'html' : 'text']: body
  };

  if (cc) mailOptions.cc = cc;
  if (bcc) mailOptions.bcc = bcc;

  try {
    const info = await transporter.sendMail(mailOptions);
    // SMTP does not file a copy anywhere; do it ourselves so the mail shows up
    // in "Sent Messages". A failure here must not turn a delivered mail into
    // an error, so it is reported separately.
    let sentCopy = true;
    let sentCopyError;
    try {
      const { appendMessage } = require('./imap-client');
      await appendMessage(await buildRaw(mailOptions), 'sent', ['\\Seen']);
    } catch (err) {
      sentCopy = false;
      sentCopyError = err.message;
    }
    return {
      success: true,
      sentCopy,
      sentCopyError,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected
    };
  } catch (error) {
    if (error.message?.includes('auth') || error.code === 'EAUTH') {
      throw new Error('UNAUTHORIZED');
    }
    throw error;
  }
}

/**
 * Verify SMTP connection
 */
async function verifyConnection() {
  const transporter = createTransporter();

  try {
    await transporter.verify();
    return true;
  } catch (error) {
    if (error.message?.includes('auth') || error.code === 'EAUTH') {
      throw new Error('UNAUTHORIZED');
    }
    throw error;
  }
}

module.exports = {
  buildRaw,
  sendEmail,
  verifyConnection
};
