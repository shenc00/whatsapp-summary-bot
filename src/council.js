// Orchestrates: fetch unseen council emails -> classify -> post WhatsApp polls.
const fs = require('fs');
const path = require('path');
const { Poll } = require('whatsapp-web.js');
const { fetchCouncilCandidateEmails } = require('./gmail');
const { classifyCouncilEmail } = require('./claude');

const STATE_FILE = path.join(__dirname, '..', 'council-state.json');
const FALLBACK_OPTIONS = ['Yes', 'No'];
// WhatsApp poll limits: 2-12 options, ~100 chars/option, ~255 char question.
const MAX_OPTION_LENGTH = 100;
const MAX_QUESTION_LENGTH = 255;

// Strips any run of "Re:"/"Fw:"/"Fwd:" prefixes so every reply in a mail
// thread collapses to the same key — one email subject gets one poll, not one
// per reply.
function normalizeSubject(subject) {
  return (subject || '')
    .replace(/^(?:\s*(?:re|fwd|fw)\s*:)+\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// State is { ids, subjects }. Older versions wrote a bare array of ids —
// still read those so an existing council-state.json keeps working.
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(raw)) return { ids: raw, subjects: [] };
    return { ids: raw.ids || [], subjects: raw.subjects || [] };
  } catch {
    return { ids: [], subjects: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

// Applies the Yes/No fallback when Claude found too few options
// (WhatsApp polls need at least 2) or any option is too long. Truncating an
// option would read as broken, so fall back to the safe default instead.
// ponytail: doesn't guard the 12-option upper bound (Claude producing 13+
// distinct options is far-fetched) — add a `.length > 12` check here if it
// ever happens.
function optionsWithFallback(options) {
  // A yes/no vote is already complete without an opt-out — drop "Abstain"
  // (and its wordier variants) before the 2-option minimum is checked.
  const kept = (options || []).filter((o) => !/^\s*(abstain|no opinion|neither)/i.test(o));
  if (kept.length < 2) return FALLBACK_OPTIONS;
  if (kept.some((o) => o.length > MAX_OPTION_LENGTH)) return FALLBACK_OPTIONS;
  return kept;
}

// Builds the poll question: one sentence of background, then the decision
// itself, so a member voting straight from the notification knows what it is
// about without opening the email thread.
function pollQuestion(background, question) {
  const parts = [background, question].map((p) => (p || '').trim()).filter(Boolean);
  return capQuestion(parts.join(' '));
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
    const state = loadState();
    const emails = await fetchCouncilCandidateEmails(state.ids);
    if (!emails.length) return { checked: 0, posted: 0, failed: 0 };

    const chat = await resolveCouncilChat(waClient);
    if (!chat) {
      throw new Error(
        `Council chat "${process.env.COUNCIL_GROUP_NAME || 'The OG Ki Council'}" not found or ambiguous.`
      );
    }

    // Emails arrive newest-first, so the first one seen for a thread is the
    // latest in it — later replies on the same subject are skipped.
    const postedSubjects = new Set(state.subjects);

    let posted = 0;
    let failed = 0;
    for (const email of emails) {
      const key = normalizeSubject(email.subject);
      if (postedSubjects.has(key)) {
        state.ids.push(email.id);
        continue;
      }
      try {
        const classification = await classifyCouncilEmail(email.subject, email.body);
        if (classification.needsDecision) {
          await chat.sendMessage(`📧 *${email.subject}* — from ${process.env.COUNCIL_SENDER || 'kiresidencesma@gmail.com'}`);
          await chat.sendMessage(
            new Poll(pollQuestion(classification.background, classification.question || email.subject), optionsWithFallback(classification.options), {
              allowMultipleAnswers: false,
            })
          );
          posted++;
          postedSubjects.add(key);
          state.subjects.push(key);
        }
      } catch (err) {
        failed++;
        console.error(`Council check: failed on email "${email.subject}" (${email.id}):`, err.message || err);
      } finally {
        state.ids.push(email.id);
      }
    }
    saveState(state);
    return { checked: emails.length, posted, failed };
  } finally {
    running = false;
  }
}

module.exports = {
  runCouncilCheck,
  normalizeSubject,
  optionsWithFallback,
  pollQuestion,
  capQuestion,
  resolveCouncilChat,
  FALLBACK_OPTIONS,
};
