/**
 * Email module for iCloud MCP
 * Provides email tools via IMAP/SMTP
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { appendMessage, deleteByMessageId, listEmails, readEmail, fetchAttachment, searchEmails, markAsRead, listFolders } = require('./imap-client');
const { sendEmail, buildRaw } = require('./smtp-client');
const { formatSuccess, formatError, withErrorHandler } = require('../utils/error-handler');
const { formatDate, formatRelative } = require('../utils/date-utils');
const config = require('../config');
const { getCredentials } = require('../auth');

/**
 * Handler: List emails
 */
async function handleListEmails(args) {
  const folder = args.folder || 'inbox';
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);

  const emails = await listEmails(folder, count);

  if (emails.length === 0) {
    return formatSuccess(`No emails found in ${folder}.`);
  }

  const lines = emails.map((email, i) => {
    const unread = !email.flags.includes('\\Seen') ? '[UNREAD] ' : '';
    const date = formatRelative(new Date(email.date));
    return `${i + 1}. ${unread}${email.subject}\n   From: ${email.from}\n   Date: ${date}\n   UID: ${email.uid}`;
  });

  return formatSuccess(`Emails in ${folder} (${emails.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Read email
 */
async function handleReadEmail(args) {
  if (!args.uid) {
    return formatError(new Error('Email UID is required'));
  }

  const folder = args.folder || 'inbox';
  const email = await readEmail(args.uid, folder);

  let body = email.text || '';
  if (body.length > config.DEFAULTS.EMAIL_BODY_MAX_LENGTH) {
    body = body.substring(0, config.DEFAULTS.EMAIL_BODY_MAX_LENGTH) + '\n... (truncated)';
  }

  const attachmentInfo = email.attachments.length > 0
    ? `\n\nAttachments (${email.attachments.length}):\n${email.attachments.map(a => `- ${a.filename} (${a.contentType}, ${Math.round(a.size / 1024)}KB)`).join('\n')}`
    : '';

  return formatSuccess(
    `Subject: ${email.subject}
From: ${email.from}
To: ${email.to}${email.cc ? `\nCC: ${email.cc}` : ''}
Date: ${formatDate(email.date)}
UID: ${email.uid}

---

${body}${attachmentInfo}`
  );
}

/**
 * Handler: Get (download) attachment
 */
async function handleGetAttachment(args) {
  if (!args.uid) {
    return formatError(new Error('Email UID is required'));
  }
  if (!args.filename) {
    return formatError(new Error('Attachment filename is required (see read-email for the list of attachments on this email)'));
  }

  const folder = args.folder || 'inbox';
  const attachment = await fetchAttachment(args.uid, folder, args.filename);

  if (attachment.size > config.DEFAULTS.MAX_ATTACHMENT_SIZE) {
    return formatError(new Error(
      `Attachment "${attachment.filename}" is ${Math.round(attachment.size / 1024 / 1024)}MB, ` +
      `exceeds the ${Math.round(config.DEFAULTS.MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB limit`
    ));
  }

  // Sanitize: drop any directory components so a crafted attachment
  // filename (or a caller-supplied one) can't escape ATTACHMENTS_DIR.
  const safeName = path.basename(attachment.filename || `attachment-${args.uid}`);
  const dir = config.ATTACHMENTS_DIR;
  fs.mkdirSync(dir, { recursive: true });

  let destPath = path.join(dir, safeName);
  if (fs.existsSync(destPath)) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    destPath = path.join(dir, `${base}-${args.uid}${ext}`);
  }

  fs.writeFileSync(destPath, attachment.content);

  return formatSuccess(
    `Saved attachment "${attachment.filename}" (${attachment.contentType}, ${Math.round(attachment.size / 1024)}KB) to:\n${destPath}`
  );
}

/**
 * Handler: Save draft (never sends)
 */
async function handleSaveDraft(args) {
  if (!args.to) return formatError(new Error('Recipient (to) is required'));
  if (!args.subject) return formatError(new Error('Subject is required'));
  if (!args.body) return formatError(new Error('Body is required'));

  const creds = getCredentials();
  const messageId = `<${crypto.randomUUID()}@${creds.email.split('@')[1]}>`;
  const raw = await buildRaw({
    from: creds.email,
    messageId,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    [args.isHtml ? 'html' : 'text']: args.body
  });
  // Append the new version first, so a failure never loses the old draft.
  await appendMessage(raw, 'drafts', ['\\Draft', '\\Seen']);

  let replaced = '';
  if (args.replaces) {
    try {
      const n = await deleteByMessageId(args.replaces, 'drafts');
      replaced = n
        ? '\nThe previous draft was replaced.'
        : '\nWARNING: the previous draft was not found (the user may have edited or sent it), so the old and new drafts now both exist.';
    } catch (err) {
      replaced = `\nWARNING: could not remove the previous draft (${err.message}); both drafts now exist.`;
    }
  }

  return formatSuccess(
    `Draft saved to "Drafts" (NOT sent). The user must review and send it from their mail client.\n\nTo: ${args.to}\nSubject: ${args.subject}\nDraft ID: ${messageId}${replaced}\n\nIf the user asks for changes, call save-draft again with the complete revised mail and replaces="${messageId}" instead of creating a new draft.`
  );
}

/**
 * Handler: Send email
 */
async function handleSendEmail(args) {
  if (!args.to) {
    return formatError(new Error('Recipient (to) is required'));
  }
  if (!args.subject) {
    return formatError(new Error('Subject is required'));
  }
  if (!args.body) {
    return formatError(new Error('Body is required'));
  }

  const result = await sendEmail({
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body,
    isHtml: args.isHtml || false
  });

  if (result.success) {
    const rejected = result.rejected?.length ? `\nRejected by server: ${result.rejected.join(', ')}` : '';
    const copy = result.sentCopy
      ? 'A copy was saved to "Sent Messages".'
      : `WARNING: mail was delivered but could not be saved to "Sent Messages" (${result.sentCopyError}).`;
    return formatSuccess(
      `Email sent successfully!\n\nTo: ${args.to}${args.cc ? `\nCC: ${args.cc}` : ''}\nSubject: ${args.subject}\nMessage ID: ${result.messageId}\nAccepted by server: ${(result.accepted || []).join(', ')}${rejected}\n${copy}`
    );
  } else {
    return formatError(new Error('Failed to send email'));
  }
}

/**
 * Handler: Search emails
 */
async function handleSearchEmails(args) {
  const folder = args.folder || 'inbox';
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);

  const criteria = {};
  if (args.from) criteria.from = args.from;
  if (args.subject) criteria.subject = args.subject;
  if (args.query) criteria.text = args.query;
  if (args.unreadOnly) criteria.unseen = true;

  const emails = await searchEmails(criteria, folder, count);

  if (emails.length === 0) {
    return formatSuccess(`No emails found matching your search criteria in ${folder}.`);
  }

  const lines = emails.map((email, i) => {
    const unread = !email.flags.includes('\\Seen') ? '[UNREAD] ' : '';
    const date = formatRelative(new Date(email.date));
    return `${i + 1}. ${unread}${email.subject}\n   From: ${email.from}\n   Date: ${date}\n   UID: ${email.uid}`;
  });

  return formatSuccess(`Search results in ${folder} (${emails.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Mark as read
 */
async function handleMarkAsRead(args) {
  if (!args.uid) {
    return formatError(new Error('Email UID is required'));
  }

  const folder = args.folder || 'inbox';
  const isRead = args.isRead !== false;

  await markAsRead(args.uid, folder, isRead);

  return formatSuccess(`Email ${args.uid} marked as ${isRead ? 'read' : 'unread'}.`);
}

/**
 * Handler: List folders
 */
async function handleListFolders() {
  const folders = await listFolders();

  const lines = folders.map(f => `- ${f.name}`);

  return formatSuccess(`Email folders:\n\n${lines.join('\n')}`);
}

// Tool definitions
const emailTools = [
  {
    name: 'list-emails',
    description: 'Lists emails from a folder (default: inbox)',
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Email folder (inbox, sent, drafts, trash, archive, junk)'
        },
        count: {
          type: 'number',
          description: 'Number of emails to retrieve (default: 25, max: 50)'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleListEmails, 'list-emails')
  },
  {
    name: 'read-email',
    description: 'Reads the full content of an email by UID',
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'The UID of the email to read'
        },
        folder: {
          type: 'string',
          description: 'Email folder (default: inbox)'
        }
      },
      required: ['uid']
    },
    handler: withErrorHandler(handleReadEmail, 'read-email')
  },
  {
    name: 'get-attachment',
    description: 'Downloads an email attachment and saves it to disk, returning the local file path. Use read-email first to see attachment filenames.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'The UID of the email the attachment is on'
        },
        filename: {
          type: 'string',
          description: 'Exact attachment filename, as shown by read-email'
        },
        folder: {
          type: 'string',
          description: 'Email folder (default: inbox)'
        }
      },
      required: ['uid', 'filename']
    },
    handler: withErrorHandler(handleGetAttachment, 'get-attachment')
  },
  {
    name: 'send-email',
    description: 'Composes and sends an email',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address(es), comma-separated'
        },
        cc: {
          type: 'string',
          description: 'CC recipient(s), comma-separated'
        },
        bcc: {
          type: 'string',
          description: 'BCC recipient(s), comma-separated'
        },
        subject: {
          type: 'string',
          description: 'Email subject'
        },
        body: {
          type: 'string',
          description: 'Email body content'
        },
        isHtml: {
          type: 'boolean',
          description: 'Whether the body is HTML (default: false)'
        }
      },
      required: ['to', 'subject', 'body']
    },
    handler: withErrorHandler(handleSendEmail, 'send-email')
  },
  {
    name: 'save-draft',
    description: 'Saves an email as a draft in the Drafts folder. Does NOT send anything; the user reviews and sends it from their own mail client.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
        cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
        bcc: { type: 'string', description: 'BCC recipient(s), comma-separated' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body content' },
        isHtml: { type: 'boolean', description: 'Whether the body is HTML (default: false)' },
        replaces: { type: 'string', description: 'Draft ID returned by an earlier save-draft call. Pass it when revising that draft, so the old version is replaced instead of a second draft being created.' }
      },
      required: ['to', 'subject', 'body']
    },
    handler: withErrorHandler(handleSaveDraft, 'save-draft')
  },
  {
    name: 'search-emails',
    description: 'Search for emails by criteria',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search in email content'
        },
        from: {
          type: 'string',
          description: 'Filter by sender'
        },
        subject: {
          type: 'string',
          description: 'Filter by subject'
        },
        folder: {
          type: 'string',
          description: 'Email folder to search (default: inbox)'
        },
        unreadOnly: {
          type: 'boolean',
          description: 'Only show unread emails'
        },
        count: {
          type: 'number',
          description: 'Max results (default: 25, max: 50)'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleSearchEmails, 'search-emails')
  },
  {
    name: 'mark-as-read',
    description: 'Marks an email as read or unread',
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'The UID of the email'
        },
        folder: {
          type: 'string',
          description: 'Email folder (default: inbox)'
        },
        isRead: {
          type: 'boolean',
          description: 'Mark as read (true) or unread (false). Default: true'
        }
      },
      required: ['uid']
    },
    handler: withErrorHandler(handleMarkAsRead, 'mark-as-read')
  },
  {
    name: 'list-folders',
    description: 'Lists all email folders',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: withErrorHandler(handleListFolders, 'list-folders')
  }
];

module.exports = {
  emailTools,
  handleListEmails,
  handleReadEmail,
  handleGetAttachment,
  handleSendEmail,
  handleSearchEmails,
  handleMarkAsRead,
  handleListFolders
};
