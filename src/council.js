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
