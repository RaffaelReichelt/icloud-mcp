/**
 * iCloud MCP Configuration
 * Centralized configuration for all iCloud services
 */

require('dotenv').config();

module.exports = {
  // Mode flags
  USE_TEST_MODE: process.env.USE_TEST_MODE === 'true',
  USE_LOCAL_MODE: process.env.USE_LOCAL_MODE !== 'false', // Default to true (local mode)

  // Check if running on macOS (required for local mode)
  IS_MACOS: process.platform === 'darwin',

  // iCloud credentials
  ICLOUD_EMAIL: process.env.ICLOUD_EMAIL,
  ICLOUD_APP_PASSWORD: process.env.ICLOUD_APP_PASSWORD,

  // IMAP settings for iCloud Mail
  IMAP: {
    HOST: 'imap.mail.me.com',
    PORT: 993,
    TLS: true,
    AUTH_TIMEOUT: 10000,
    CONN_TIMEOUT: 30000
  },

  // SMTP settings for sending mail
  SMTP: {
    HOST: 'smtp.mail.me.com',
    PORT: 587,
    SECURE: false  // Uses STARTTLS
  },

  // CalDAV settings for Calendar
  CALDAV: {
    SERVER_URL: 'https://caldav.icloud.com',
    // Principal URL will be discovered during auth
    AUTH_METHOD: 'Basic'
  },

  // CardDAV settings for Contacts
  CARDDAV: {
    SERVER_URL: 'https://contacts.icloud.com',
    AUTH_METHOD: 'Basic'
  },

  // Default settings
  DEFAULTS: {
    TIMEZONE: 'Europe/Madrid',
    PAGE_SIZE: 25,
    MAX_RESULTS: 50,
    EMAIL_BODY_MAX_LENGTH: 50000,
    DATE_FORMAT: 'es-ES',
    MAX_ATTACHMENT_SIZE: 25 * 1024 * 1024 // 25MB
  },

  // Where downloaded email attachments get written (get-attachment tool).
  // Caller (e.g. nanobot) should point this at a per-user private dir via
  // an env var when spawning this server, so files land somewhere the
  // caller's own file tools can read them back.
  ATTACHMENTS_DIR: process.env.ICLOUD_ATTACHMENTS_DIR || './attachments',

  // Email folder mappings
  EMAIL_FOLDERS: {
    inbox: 'INBOX',
    sent: 'Sent Messages',
    drafts: 'Drafts',
    trash: 'Deleted Messages',
    archive: 'Archive',
    junk: 'Junk'
  }
};
