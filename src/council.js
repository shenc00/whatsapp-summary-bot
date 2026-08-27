// Orchestrates: fetch unseen council emails -> classify -> post WhatsApp polls.
const fs = require('fs');
const path = require('path');
const { Poll } = require('whatsapp-web.js');
const { fetchCouncilCandidateEmails } = require('./gmail');
const { classifyCouncilEmail } = require('./claude');

const STATE_FILE = path.join(__dirname, '..', 'council-state.json');
const FALLBACK_OPTIONS = ['Yes', 'No', 'Abstain'];
// WhatsApp poll limits: 2-12 options, ~100 chars/option, ~255 char question.
const MAX_OPTION_LENGTH = 100;
const MAX_QUESTION_LENGTH = 255;

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

// Applies the Yes/No/Abstain fallback when Claude found too few options
// (WhatsApp polls need at least 2) or any option is too long. Truncating an
// option would read as broken, so fall back to the safe default instead.
// ponytail: doesn't guard the 12-option upper bound (Claude producing 13+
// distinct options is far-fetched) — add a `.length > 12` check here if it
// ever happens.
function optionsWithFallback(options) {
  if (!options || options.length < 2) return FALLBACK_OPTIONS;
  if (options.some((o) => o.length > MAX_OPTION_LENGTH)) return FALLBACK_OPTIONS;
  return options;
}

// Caps the poll question length — safe to truncate (unlike an option, it's
// not a selectable choice).
function capQuestion(question) {
  if (question.length <= MAX_QUESTION_LENGTH) return question;
  return question.slice(0, MAX_QUESTION_LENGTH - 1).trimEnd() + '…';
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

// Guards against two concurrent runs (manual !councilpoll overlapping the
// hourly timer, or being fired twice while a Claude call is in flight) —
// both would load the same state file and could double-post the same poll.
// ponytail: single in-process boolean; fine for one bot process, not a
// cross-process lock.
let running = false;

// Runs one fetch+classify+post cycle. Posts one poll per email that needs a
// decision. Every email is marked processed after its attempt regardless of
// outcome — a per-email error (classification failure, a Poll send that
// WhatsApp rejects, etc.) is logged and counted in `failed`, but never
// retried, so a single bad email can't loop forever. The chat is resolved
// ONCE up front: if it's not found/ambiguous that's a config problem (not a
// per-email one), so it throws and aborts the whole run before anything is
// marked processed — the caller should retry the whole run next time.
async function runCouncilCheck(waClient) {
  if (running) return { checked: 0, posted: 0, failed: 0 };
  running = true;
  try {
    const processedIds = loadProcessedIds();
    const emails = await fetchCouncilCandidateEmails(processedIds);
    if (!emails.length) return { checked: 0, posted: 0, failed: 0 };

    const chat = await resolveCouncilChat(waClient);
    if (!chat) {
      throw new Error(
        `Council chat "${process.env.COUNCIL_GROUP_NAME || 'The OG Ki Council'}" not found or ambiguous.`
      );
    }

    let posted = 0;
    let failed = 0;
    for (const email of emails) {
      try {
        const classification = await classifyCouncilEmail(email.subject, email.body);
        if (classification.needsDecision) {
          await chat.sendMessage(`📧 *${email.subject}* — from ${process.env.COUNCIL_SENDER || 'kiresidencesma@gmail.com'}`);
          await chat.sendMessage(
            new Poll(capQuestion(classification.question || email.subject), optionsWithFallback(classification.options), {
              allowMultipleAnswers: false,
            })
          );
          posted++;
        }
      } catch (err) {
        failed++;
        console.error(`Council check: failed on email "${email.subject}" (${email.id}):`, err.message || err);
      } finally {
        processedIds.push(email.id);
      }
    }
    saveProcessedIds(processedIds);
    return { checked: emails.length, posted, failed };
  } finally {
    running = false;
  }
}

module.exports = {
  runCouncilCheck,
  optionsWithFallback,
  capQuestion,
  resolveCouncilChat,
  FALLBACK_OPTIONS,
};
