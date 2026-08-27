# Council Email → WhatsApp Poll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 6 is a live, interactive task (Google Cloud Console clicks + real Gmail/WhatsApp accounts) and cannot be delegated to a subagent — it must run inline with the user present.**

**Goal:** Detect emails from `kiresidencesma@gmail.com` that require a council decision and post them as WhatsApp polls in "The OG Ki Council".

**Architecture:** `src/gmail.js` (Gmail OAuth + fetch) → `src/claude.js` (new `classifyCouncilEmail`) → `src/council.js` (orchestration: fetch, classify, post poll, dedup) → wired into `src/index.js` as a manual `!councilpoll` command first, then (after live validation) a 60-minute background interval. One-time OAuth setup lives in `src/gmail-auth.js`.

**Tech Stack:** Node.js (CommonJS, matches existing repo), `googleapis` (new dependency), existing `@anthropic-ai/sdk` and `whatsapp-web.js`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-council-email-poll-design.md` — every task below implements a section of it.
- Gmail query: `from:${COUNCIL_SENDER} to:cshen.1002@gmail.com newer_than:7d`, default `COUNCIL_SENDER=kiresidencesma@gmail.com`.
- Poll: single choice (`allowMultipleAnswers: false`), fallback options `['Yes', 'No', 'Abstain']` when Claude finds no explicit options in the email.
- Target WhatsApp group: `COUNCIL_GROUP_NAME` env, default `"The OG Ki Council"`.
- Dedup: every fetched email's Gmail message ID is recorded in `council-state.json` after processing, regardless of `needsDecision` outcome; a per-email classify/post error is logged and left unprocessed (retried next run) instead of crashing the batch.
- No test framework — this repo has zero test infra today. Match that: one assert-based `test_council.js` at repo root, run via `node test_council.js`.
- New gitignored files: `gmail-token.json`, `council-state.json` (same treatment as the existing `autoreply.json` state file, which is also gitignored but not `.env`-secret).
- Do not wire the automatic interval into `index.js` until Task 6 (live validation) has passed — Task 5 ships the manual `!councilpoll` command only.

---

### Task 1: Gmail OAuth client + fetch (`src/gmail.js`)

**Files:**
- Create: `src/gmail.js`
- Modify: `.env.example` (append `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COUNCIL_SENDER`)
- Modify: `.gitignore` (append `gmail-token.json`)
- Modify: `package.json` (add `googleapis` dependency)
- Test: `test_council.js` (new file)

**Interfaces:**
- Produces: `hasValidToken(): boolean`, `getOAuthClient(): OAuth2Client`, `fetchCouncilCandidateEmails(processedIds: string[]): Promise<Array<{id: string, subject: string, date: string, body: string}>>` (newest first), `filterUnprocessed(emails: Array<{id: string}>, processedIds: string[]): Array<{id: string}>`, `extractBody(payload): string`, `REDIRECT_URI: string`, `SCOPES: string[]`, `TOKEN_PATH: string`.

- [ ] **Step 1: Install the `googleapis` dependency**

Run: `cd "C:\Users\10320283\OneDrive - BD\Documents\Github\whatsapp-summary-bot" && npm install googleapis`
Expected: `package.json` and `package-lock.json` both gain a `googleapis` entry.

- [ ] **Step 2: Write `src/gmail.js`**

```js
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
```

- [ ] **Step 3: Write `test_council.js`**

```js
// test_council.js — assert-based self-check for the council-email-poll
// feature's pure logic. No framework, no network calls.
// Requires a real .env (for ANTHROPIC_API_KEY, since requiring src/claude.js
// constructs the Anthropic client). Run: node test_council.js
require('dotenv').config();
const assert = require('assert');

function testGmailHelpers() {
  const { filterUnprocessed, extractBody } = require('./src/gmail');

  const unprocessed = filterUnprocessed(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    ['a', 'c']
  );
  assert.deepStrictEqual(unprocessed.map((e) => e.id), ['b']);

  const plainTextPayload = {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hello council').toString('base64url') } }],
  };
  assert.strictEqual(extractBody(plainTextPayload), 'Hello council');

  const htmlOnlyPayload = {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>Hi <b>team</b></p>').toString('base64url') } }],
  };
  assert.strictEqual(extractBody(htmlOnlyPayload), 'Hi team');

  const nestedPayload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('Nested plain body').toString('base64url') } },
          { mimeType: 'text/html', body: { data: Buffer.from('<p>Nested html</p>').toString('base64url') } },
        ],
      },
    ],
  };
  assert.strictEqual(extractBody(nestedPayload), 'Nested plain body');

  console.log('gmail.js: PASS');
}

testGmailHelpers();
console.log('All council tests passed.');
```

- [ ] **Step 4: Run the test**

Run: `node test_council.js`
Expected: prints `gmail.js: PASS` then `All council tests passed.` with exit code 0.

- [ ] **Step 5: Add env/gitignore entries**

Append to `.env.example`:
```
# Optional — council email -> WhatsApp poll feature. Leave unset to disable
# (the bot logs a note at startup and skips the background check).
# From a Google Cloud OAuth client (Desktop app type) with the Gmail API
# enabled. Run `npm run gmail:auth` once after setting these.
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...

# Optional — sender to watch for council decision emails.
# COUNCIL_SENDER=kiresidencesma@gmail.com
```

Append to `.gitignore`:
```
gmail-token.json
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/gmail.js test_council.js .env.example .gitignore
git commit -m "feat: add Gmail OAuth client and council-email fetch"
```

---

### Task 2: One-time OAuth setup script (`src/gmail-auth.js`)

**Files:**
- Create: `src/gmail-auth.js`
- Modify: `package.json` (add `gmail:auth` script)

**Interfaces:**
- Consumes: `REDIRECT_URI`, `SCOPES`, `TOKEN_PATH` from `src/gmail.js` (Task 1).
- Produces: writes `gmail-token.json` at repo root when run interactively. No exports (standalone script).

- [ ] **Step 1: Write `src/gmail-auth.js`**

```js
// One-time interactive Gmail OAuth setup. Run: npm run gmail:auth
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const { google } = require('googleapis');
const { REDIRECT_URI, SCOPES, TOKEN_PATH } = require('./gmail');

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error('❌ Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see .env.example).');
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

const port = Number(new URL(REDIRECT_URI).port);
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.end('Not found.');
    return;
  }
  const code = new URL(req.url, REDIRECT_URI).searchParams.get('code');
  res.end('Authenticated — you can close this tab and return to the terminal.');
  server.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log(`✅ Saved Gmail token to ${TOKEN_PATH}`);
  } catch (err) {
    console.error('❌ Failed to exchange code for token:', err.message);
    process.exitCode = 1;
  }
});

server.listen(port, () => {
  console.log('\n📧 Open this URL in a browser and approve access with cshen.1002@gmail.com:\n');
  console.log(authUrl + '\n');
});
```

- [ ] **Step 2: Add the npm script**

Modify `package.json`'s `"scripts"` block to:
```json
"scripts": {
  "start": "node src/index.js",
  "gmail:auth": "node src/gmail-auth.js"
}
```

- [ ] **Step 3: Verify it starts without crashing (auth URL generation only — no browser flow yet)**

Run: `node -e "require('dotenv').config(); process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test'; process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test'; const { google } = require('googleapis'); const { REDIRECT_URI, SCOPES } = require('./src/gmail'); const c = new google.auth.OAuth2('test','test',REDIRECT_URI); console.log(c.generateAuthUrl({ access_type: 'offline', scope: SCOPES }));"`
Expected: prints a `https://accounts.google.com/o/oauth2/v2/auth?...` URL, no crash.

- [ ] **Step 4: Commit**

```bash
git add src/gmail-auth.js package.json
git commit -m "feat: add one-time Gmail OAuth setup script"
```

---

### Task 3: Claude classification (`src/claude.js`)

**Files:**
- Modify: `src/claude.js` (add `classifyCouncilEmail`, `parseClassification`, export both; existing functions/exports at [src/claude.js:1-343](src/claude.js) untouched)
- Test: `test_council.js` (append)

**Interfaces:**
- Consumes: `createWithRetry`, `textOf`, `MODEL`, `THINKING_PARAM` — all already defined earlier in `src/claude.js`.
- Produces: `classifyCouncilEmail(subject: string, body: string): Promise<{needsDecision: boolean, question: string, options: string[]}>`, `parseClassification(raw: string): {needsDecision: boolean, question: string, options: string[]}`.

- [ ] **Step 1: Add `parseClassification` and `classifyCouncilEmail` to `src/claude.js`**

Insert after the existing `extractAbsurdComments` function (right before the `// Shared humanizing style rules...` comment block, i.e. after [src/claude.js:218](src/claude.js#L218)):

```js
// Parses Claude's classification JSON, tolerant of markdown code fences.
// Falls back to needsDecision:false on any parse failure — never guess.
function parseClassification(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      needsDecision: Boolean(parsed.needsDecision),
      question: typeof parsed.question === 'string' ? parsed.question : '',
      options: Array.isArray(parsed.options) ? parsed.options.filter((o) => typeof o === 'string') : [],
    };
  } catch {
    return { needsDecision: false, question: '', options: [] };
  }
}

async function classifyCouncilEmail(subject, body) {
  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 500,
    ...THINKING_PARAM,
    system:
      "You read one email sent to a residential council (a residents' committee) and decide " +
      'whether it requires the council to make a decision (a vote, approval, or choice between ' +
      'options), as opposed to being purely informational or discussion. Respond with ONLY raw ' +
      'JSON (no markdown fences, no explanation), matching exactly this shape:\n' +
      '{"needsDecision": true|false, "question": "<the decision being asked, or empty string>", ' +
      '"options": ["<option 1>", "<option 2>", ...]}\n\n' +
      'Set "options" to the explicit choices offered in the email text (e.g. named proposals, ' +
      'or "approve"/"reject"). Leave "options" as an empty array if the email does not spell out ' +
      'explicit choices — do not invent options. If "needsDecision" is false, set "question" to ' +
      'an empty string and "options" to an empty array.',
    messages: [
      {
        role: 'user',
        content: `Subject: ${subject}\n\nBody:\n${body}`,
      },
    ],
  });
  return parseClassification(textOf(message));
}
```

- [ ] **Step 2: Add both to `module.exports` in `src/claude.js`**

Modify the `module.exports` block at [src/claude.js:331-343](src/claude.js#L331-L343):
```js
module.exports = {
  summariseTranscript,
  summariseByPerson,
  profilePerson,
  analyseRelationships,
  summariseMeetup,
  extractAbsurdComments,
  draftReply,
  autoReplyMessage,
  ask,
  classifyCouncilEmail,
  parseClassification,
  isOverloaded,
  MODEL,
};
```

- [ ] **Step 3: Append to `test_council.js`**

Add before the final `console.log('All council tests passed.');` line:

```js
function testClaudeHelpers() {
  const { parseClassification } = require('./src/claude');

  const clean = parseClassification('{"needsDecision": true, "question": "Approve the new gate vendor?", "options": ["Vendor A", "Vendor B"]}');
  assert.deepStrictEqual(clean, { needsDecision: true, question: 'Approve the new gate vendor?', options: ['Vendor A', 'Vendor B'] });

  const fenced = parseClassification('```json\n{"needsDecision": false, "question": "", "options": []}\n```');
  assert.deepStrictEqual(fenced, { needsDecision: false, question: '', options: [] });

  const garbage = parseClassification('not json at all');
  assert.deepStrictEqual(garbage, { needsDecision: false, question: '', options: [] });

  console.log('claude.js: PASS');
}

testClaudeHelpers();
```

- [ ] **Step 4: Run the test**

Run: `node test_council.js`
Expected: `gmail.js: PASS`, `claude.js: PASS`, `All council tests passed.`

- [ ] **Step 5: Commit**

```bash
git add src/claude.js test_council.js
git commit -m "feat: add Claude council-email decision classification"
```

---

### Task 4: Orchestration (`src/council.js`)

**Files:**
- Create: `src/council.js`
- Modify: `.env.example` (append `COUNCIL_GROUP_NAME`)
- Modify: `.gitignore` (append `council-state.json`)
- Test: `test_council.js` (append)

**Interfaces:**
- Consumes: `fetchCouncilCandidateEmails` (Task 1, `src/gmail.js`), `classifyCouncilEmail` (Task 3, `src/claude.js`), `Poll` (from `whatsapp-web.js`, already a dependency).
- Produces: `runCouncilCheck(waClient): Promise<{checked: number, posted: number}>`, `optionsWithFallback(options: string[]): string[]`, `resolveCouncilChat(waClient): Promise<Chat|null>`, `FALLBACK_OPTIONS: string[]`.

- [ ] **Step 1: Write `src/council.js`**

```js
// Orchestrates: fetch unseen council emails -> classify -> post WhatsApp polls.
const fs = require('fs');
const path = require('path');
const { Poll } = require('whatsapp-web.js');
const { fetchCouncilCandidateEmails } = require('./gmail');
const { classifyCouncilEmail } = require('./claude');

const STATE_FILE = path.join(__dirname, '..', 'council-state.json');
const FALLBACK_OPTIONS = ['Yes', 'No', 'Abstain'];

function loadProcessedIds() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveProcessedIds(ids) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(ids));
}

// Applies the Yes/No/Abstain fallback when Claude found no explicit options.
function optionsWithFallback(options) {
  return options && options.length ? options : FALLBACK_OPTIONS;
}

// Finds the configured council WhatsApp group among the account's chats.
// Exact name match first, then falls back to a unique case-insensitive
// substring match (same pattern as resolveChatRef in src/index.js).
async function resolveCouncilChat(waClient) {
  const groupName = process.env.COUNCIL_GROUP_NAME || 'The OG Ki Council';
  const chats = await waClient.getChats();
  const lower = groupName.toLowerCase();
  const exact = chats.find((c) => (c.name || '').toLowerCase() === lower);
  if (exact) return exact;
  const matches = chats.filter((c) => (c.name || '').toLowerCase().includes(lower));
  return matches.length === 1 ? matches[0] : null;
}

// Runs one fetch+classify+post cycle. Posts one poll per email that needs a
// decision. A per-email failure is logged and left unmarked (retried next
// run); a fetch-level failure (e.g. bad/expired Gmail token) throws so the
// caller can report it.
async function runCouncilCheck(waClient) {
  const processedIds = loadProcessedIds();
  const emails = await fetchCouncilCandidateEmails(processedIds);
  if (!emails.length) return { checked: 0, posted: 0 };

  let posted = 0;
  for (const email of emails) {
    try {
      const classification = await classifyCouncilEmail(email.subject, email.body);
      if (classification.needsDecision) {
        const chat = await resolveCouncilChat(waClient);
        if (!chat) {
          console.error(
            `Council chat "${process.env.COUNCIL_GROUP_NAME || 'The OG Ki Council'}" not found ` +
            `or ambiguous — skipping poll for "${email.subject}".`
          );
        } else {
          await chat.sendMessage(`📧 *${email.subject}* — from ${process.env.COUNCIL_SENDER || 'kiresidencesma@gmail.com'}`);
          await chat.sendMessage(
            new Poll(classification.question || email.subject, optionsWithFallback(classification.options), {
              allowMultipleAnswers: false,
            })
          );
          posted++;
        }
      }
      processedIds.push(email.id);
    } catch (err) {
      console.error(`Council check: failed on email "${email.subject}" (${email.id}):`, err.message || err);
    }
  }
  saveProcessedIds(processedIds);
  return { checked: emails.length, posted };
}

module.exports = {
  runCouncilCheck,
  optionsWithFallback,
  resolveCouncilChat,
  FALLBACK_OPTIONS,
};
```

- [ ] **Step 2: Append to `test_council.js`**

Add before `console.log('All council tests passed.');`:

```js
function testCouncilHelpers() {
  const { optionsWithFallback, FALLBACK_OPTIONS } = require('./src/council');

  assert.deepStrictEqual(optionsWithFallback(['Vendor A', 'Vendor B']), ['Vendor A', 'Vendor B']);
  assert.deepStrictEqual(optionsWithFallback([]), FALLBACK_OPTIONS);
  assert.deepStrictEqual(optionsWithFallback(undefined), FALLBACK_OPTIONS);

  console.log('council.js: PASS');
}

testCouncilHelpers();
```

- [ ] **Step 3: Run the test**

Run: `node test_council.js`
Expected: `gmail.js: PASS`, `claude.js: PASS`, `council.js: PASS`, `All council tests passed.`

- [ ] **Step 4: Add env/gitignore entries**

Append to `.env.example`:
```
# Optional — WhatsApp group name to post council decision polls into.
# COUNCIL_GROUP_NAME=The OG Ki Council
```

Append to `.gitignore`:
```
council-state.json
```

- [ ] **Step 5: Commit**

```bash
git add src/council.js test_council.js .env.example .gitignore
git commit -m "feat: add council-email orchestration and poll posting"
```

---

### Task 5: Manual `!councilpoll` command (`src/index.js`)

**Files:**
- Modify: `src/index.js` (add require, command handler, help text)

**Interfaces:**
- Consumes: `runCouncilCheck(waClient)` from Task 4 (`src/council.js`).

- [ ] **Step 1: Add the require**

Modify [src/index.js:19](src/index.js#L19) (right after the `require('./claude')` block closes):
```js
} = require('./claude');
const { runCouncilCheck } = require('./council');
```

- [ ] **Step 2: Add the command handler**

Modify [src/index.js:376-385](src/index.js#L376-L385) — insert a new `else if` branch right after the `!ai` block and before `} else if (command === '!autoreply') {`:

```js
    } else if (command === '!councilpoll') {
      await selfChat.sendStateTyping();
      const { checked, posted } = await runCouncilCheck(client);
      await selfChat.sendMessage(
        checked === 0
          ? '_(No new emails from the council sender found.)_'
          : `✅ Checked ${checked} email(s), posted ${posted} poll(s) to the council group.`
      );

    } else if (command === '!autoreply') {
```
(This replaces the line `} else if (command === '!autoreply') {` — delete the old line, the block above already includes its replacement.)

- [ ] **Step 3: Add the help text line**

Modify [src/index.js:451-452](src/index.js#L451-L452) — insert a new bullet between the `!ai` line and the `!autoreply` line:
```js
          '• `!ai <question>` — ask Claude anything\n' +
          '• `!councilpoll` — check for new council decision emails and post polls for any found\n' +
          '• `!autoreply <chat#|name> on [tone] | off` — toggle live auto-replies in a chat\n' +
```

- [ ] **Step 4: Syntax-check the file**

Run: `node --check src/index.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Manual smoke test**

Run: `npm start`, wait for `✅ Bot is ready!`, then in your own Saved Messages chat type `!councilpoll`.
Expected: bot replies with either `_(No new emails from the council sender found.)_` or a checked/posted count — **note:** this will fail with a clear error (caught by the existing outer try/catch, surfaced as `⚠️ Something went wrong handling that command.`) until Task 6's OAuth token exists. That failure is expected at this point in the plan — confirms the command is wired up; Task 6 makes it actually work.

- [ ] **Step 6: Commit**

```bash
git add src/index.js
git commit -m "feat: add !councilpoll command"
```

---

### Task 6: Live validation (interactive, not a subagent task)

**Files:** none (operational task).

This task is done together with the user, in real time — it needs Google Cloud Console access and a real Gmail/WhatsApp session.

- [ ] **Step 1: Create the Google Cloud OAuth client**
  1. console.cloud.google.com → select/create a project.
  2. APIs & Services → Library → enable "Gmail API".
  3. APIs & Services → OAuth consent screen → External → add `cshen.1002@gmail.com` as a test user.
  4. APIs & Services → Credentials → Create Credentials → OAuth client ID → **Desktop app** → copy the Client ID and Client Secret.

- [ ] **Step 2: Configure `.env`**

Add to `.env` (not `.env.example`):
```
GOOGLE_CLIENT_ID=<paste>
GOOGLE_CLIENT_SECRET=<paste>
```

- [ ] **Step 3: Run the OAuth setup script**

Run: `npm run gmail:auth`
Expected: prints a Google consent URL. Open it, sign in as `cshen.1002@gmail.com`, approve. Terminal prints `✅ Saved Gmail token to <path>\gmail-token.json`.

- [ ] **Step 4: Start the bot and run `!councilpoll` for real**

Run: `npm start`, wait for `✅ Bot is ready!`, type `!councilpoll` in Saved Messages.
Expected: either `_(No new emails from the council sender found.)_` (no decision-needed email in the last 7 days) or a poll posted in "The OG Ki Council" — check the group: one context message (`📧 <subject> — from kiresidencesma@gmail.com`) followed by a single-choice poll with a sensible question and options.

- [ ] **Step 5: Confirm with the user**

Ask the user to confirm the poll (or the "nothing found" result, if that's genuinely correct for their inbox right now) looks right before proceeding to Task 7. Do not proceed on your own judgment — this is the explicit gate the spec calls for.

---

### Task 7: Wire the automatic 60-minute interval (`src/index.js`)

**Files:**
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `hasValidToken()` from `src/gmail.js` (Task 1), `runCouncilCheck(waClient)` from `src/council.js` (Task 4).

- [ ] **Step 1: Add the require and interval constant**

Modify [src/index.js:19](src/index.js#L19), extending the require line added in Task 5:
```js
const { runCouncilCheck } = require('./council');
const { hasValidToken } = require('./gmail');
```

Modify [src/index.js:28](src/index.js#L28) — add a new constant next to `CHATS_LIST_LIMIT`:
```js
const CHATS_LIST_LIMIT = 10;
const COUNCIL_POLL_INTERVAL_MS = 60 * 60 * 1000;
```

- [ ] **Step 2: Start the interval in the `ready` handler**

Modify [src/index.js:101-104](src/index.js#L101-L104):
```js
client.on('ready', () => {
  console.log(`✅ Bot is ready! Using model: ${MODEL}`);
  console.log('   Type commands in your own "Saved Messages" chat: !chats · !summary · !personal · !profile · !relationships · !meetup · !absurd · !ai · !councilpoll · !autoreply · !help');

  if (hasValidToken()) {
    setInterval(async () => {
      try {
        const { checked, posted } = await runCouncilCheck(client);
        if (posted > 0) {
          console.log(`Council check: ${checked} email(s) checked, ${posted} poll(s) posted.`);
        }
      } catch (err) {
        console.error('Council check failed:', err.message || err);
        try {
          const selfChat = await client.getChatById(client.info.wid._serialized);
          await selfChat.sendMessage(`⚠️ Council email check failed: ${err.message || err}`);
        } catch {
          /* ignore */
        }
      }
    }, COUNCIL_POLL_INTERVAL_MS);
    console.log(`   Council email check running every ${COUNCIL_POLL_INTERVAL_MS / 60000} min.`);
  } else {
    console.log('   Council email check disabled — run `npm run gmail:auth` to enable it.');
  }
});
```

- [ ] **Step 3: Syntax-check**

Run: `node --check src/index.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual verification**

Run: `npm start`.
Expected: after `✅ Bot is ready!`, the log shows `Council email check running every 60 min.` (token exists from Task 6). Leave it running; within the hour, either nothing happens (no new emails) or a new poll appears in "The OG Ki Council" and a `Council check: N email(s) checked, M poll(s) posted.` line prints.

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat: run council email check automatically every 60 minutes"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture (Tasks 1/3/4/5/7), data flow fetch/classify/post/mark-processed (Tasks 1/3/4), config additions (Tasks 1/4/6), error handling — interval vs command (Task 7 vs existing outer catch used by Task 5), setup prerequisites (Task 6), validation-before-automation ordering (Task 6 gates Task 7), testing (Tasks 1/3/4 test_council.js sections), out-of-scope items (no poll-result reading, no extra retry, single hardcoded group) — none of the later tasks add any of these back in.
- **Placeholder scan:** none found — every step has literal code/commands.
- **Type consistency:** `runCouncilCheck(waClient)` signature matches across Task 4 (definition), Task 5 (`!councilpoll` call), Task 7 (interval call) — no `selfChat` parameter anywhere, confirmed dropped consistently since Task 4's error handling only logs, it doesn't message chat directly. `optionsWithFallback`, `resolveCouncilChat`, `FALLBACK_OPTIONS` names match between Task 4's definition and its test in the same task.
