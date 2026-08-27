// Gmail OAuth client + fetching candidate council emails.
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(__dirname, '..', 'gmail-token.json');
const REDIRECT_URI = 'http://localhost:53682/oauth2callback';
const COUNCIL_RECIPIENT = 'cshen.1002@gmail.com';

function hasValidToken() {
  return fs.existsSync(TOKEN_PATH);
}

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
  if (hasValidToken()) {
    client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  }
  return client;
}

// Recursively finds the first body part of the given MIME type in a Gmail
// message payload (handles nested multipart/mixed > multipart/alternative).
function findPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  for (const part of payload.parts || []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return null;
}

// Gmail encodes body data as URL-safe base64 ("base64url"), not plain base64.
function decodePart(part) {
  return Buffer.from(part.body.data, 'base64url').toString('utf8');
}

// Prefers plain text; falls back to a crude HTML-tag strip if that's all
// the email offers.
function extractBody(payload) {
  const plain = findPart(payload, 'text/plain');
  if (plain) return decodePart(plain);
  const html = findPart(payload, 'text/html');
  if (html) return decodePart(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Drops any email whose Gmail message ID is already in processedIds.
function filterUnprocessed(emails, processedIds) {
  const seen = new Set(processedIds);
  return emails.filter((e) => !seen.has(e.id));
}

// Fetches emails from COUNCIL_SENDER to the council recipient, from the
// last 7 days, excluding anything already in processedIds. Newest first.
async function fetchCouncilCandidateEmails(processedIds) {
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const sender = process.env.COUNCIL_SENDER || 'kiresidencesma@gmail.com';
  const q = `from:${sender} to:${COUNCIL_RECIPIENT} newer_than:7d`;

  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 25 });
  const candidateIds = (list.data.messages || []).map((m) => ({ id: m.id }));
  const unseenIds = filterUnprocessed(candidateIds, processedIds).map((e) => e.id);

  const emails = [];
  for (const id of unseenIds) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = msg.data.payload.headers;
    emails.push({
      id,
      subject: headerValue(headers, 'Subject'),
      date: headerValue(headers, 'Date'),
      body: extractBody(msg.data.payload),
    });
  }
  emails.sort((a, b) => new Date(b.date) - new Date(a.date));
  return emails;
}

module.exports = {
  hasValidToken,
  getOAuthClient,
  fetchCouncilCandidateEmails,
  filterUnprocessed,
  extractBody,
  REDIRECT_URI,
  SCOPES,
  TOKEN_PATH,
};
