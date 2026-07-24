// Claude integration — summarisation and conversational replies.
// Uses the official Anthropic SDK. The API key is read from ANTHROPIC_API_KEY.
const Anthropic = require('@anthropic-ai/sdk');

// maxRetries: the SDK auto-retries with backoff on transient errors
// (429 rate limit, 500/503/529 overloaded) — 5 gives overload spikes more
// room to clear before we give up.
const client = new Anthropic({ maxRetries: 5 }); // reads ANTHROPIC_API_KEY from the environment

// Default to the most capable Opus model. Override with CLAUDE_MODEL in .env
// (e.g. claude-haiku-4-5 for faster / cheaper replies).
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

// Adaptive thinking is only supported on Opus and Sonnet models, not Haiku.
const SUPPORTS_THINKING = !MODEL.includes('haiku');
const THINKING_PARAM = SUPPORTS_THINKING ? { thinking: { type: 'adaptive' } } : {};

// Pull the plain-text out of a Claude response (skips thinking blocks).
function textOf(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function isOverloaded(err) {
  return err?.status === 529 || err?.error?.error?.type === 'overloaded_error';
}

// On top of the SDK's own internal retries, retry overload errors a few more
// times with longer backoff — overload spikes can outlast the SDK's budget.
async function createWithRetry(params, { attempts = 3, baseDelayMs = 4000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      const lastAttempt = i === attempts - 1;
      if (!isOverloaded(err) || lastAttempt) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
}

async function summariseTranscript(transcript) {
  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 2048,
    ...THINKING_PARAM,
    system:
      'You summarise WhatsApp group chats. Produce a tight, skimmable summary of ' +
      'the conversation below. Lead with a one-line TL;DR, then bullet the key ' +
      'topics, decisions, and any open questions or action items (note who owns ' +
      'each). Keep it concise and neutral. Do not invent details that are not in ' +
      'the transcript.',
    messages: [
      {
        role: 'user',
        content: `Here is the chat transcript (oldest to newest):\n\n${transcript}`,
      },
    ],
  });
  return textOf(message) || '(No summary produced.)';
}

async function summariseByPerson(transcript, personName = null) {
  const system = personName
    ? `You extract one person's contributions from a WhatsApp group chat transcript. ` +
      `Focus ONLY on messages sent by "${personName}" (match case-insensitively, allow ` +
      `partial or nickname matches). Summarise what they said, asked, or contributed in ` +
      `2-6 concise bullet points. Only include other people's messages as brief context ` +
      `if needed to understand "${personName}"'s point. If no messages from "${personName}" ` +
      'are found in the transcript, say so clearly instead of guessing.'
    : 'You summarise WhatsApp group chats on a per-person basis. ' +
      'For each person who spoke, write a short section (2-5 bullet points) ' +
      'capturing what they said, asked, or contributed. ' +
      'Use the format:\n\n*Name*\n• ...\n• ...\n\n' +
      'Order people by how much they contributed (most first). ' +
      'Be concise and neutral. Do not invent anything not in the transcript.';

  const message = await createWithRetry({
    model: MODEL,
    max_tokens: personName ? 1024 : 3000,
    ...THINKING_PARAM,
    system,
    messages: [
      {
        role: 'user',
        content: `Here is the chat transcript (oldest to newest):\n\n${transcript}`,
      },
    ],
  });
  return textOf(message) || '(No summary produced.)';
}

async function profilePerson(transcript, personName) {
  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 2000,
    ...THINKING_PARAM,
    system:
      `You build a lightweight personality profile for "${personName}" from their messages, ` +
      'pulled from one or more WhatsApp chat transcripts (each block below is labelled with ' +
      'which chat it came from). Match the name case-insensitively, allowing partial or ' +
      'nickname matches, and combine everything they wrote across all the labelled chats into ' +
      'one unified profile. Base everything strictly on what they wrote and how they wrote it — ' +
      'tone, word choice, topics they bring up, how they react to others, humor, emoji use, ' +
      'message length/frequency, and whether their style shifts between chats. Never use ' +
      'real-world facts about named public figures; judge only the text in front of you.\n\n' +
      'Output this format:\n\n' +
      `*Profile: ${personName}*\n` +
      '• Estimated age range: <e.g. "20s-30s"> — <one short clue from the text>\n' +
      '• Personality traits: <3-5 adjectives, comma separated>\n' +
      '• Communication style: <1-2 sentences>\n' +
      '• Likely interests/role in the group: <1-2 sentences>\n' +
      '• Notable quirks: <1-2 sentences, optional, omit if none>\n' +
      '• Estimated MBTI type: <4-letter code like INTJ, ESFP, etc.> — <2-3 sentences explaining reasoning>\n\n' +
      'For the MBTI deduction, look for patterns in:\n' +
      '  - Introversion/Extraversion: social energy (frequent engagement, group banter vs. observing, few words)\n' +
      '  - Sensing/Intuition: focus on concrete details and facts vs. big-picture ideas and possibilities\n' +
      '  - Thinking/Feeling: logical analysis and directness vs. emotion, empathy, and concern for group harmony\n' +
      '  - Judging/Perceiving: preference for structure and decisiveness vs. flexibility and spontaneity\n\n' +
      'Be speculative but grounded — qualify guesses with words like "seems", "appears to", "possibly". ' +
      `If "${personName}" has no messages in any of the transcripts, say so clearly instead of guessing.`,
    messages: [
      {
        role: 'user',
        content: `Here are the chat transcript(s) (oldest to newest within each):\n\n${transcript}`,
      },
    ],
  });
  return textOf(message) || '(No profile produced.)';
}

async function analyseRelationships(transcript, names = null) {
  const focus = names && names.length
    ? `Focus on these people in particular if mentioned: ${names.join(', ')}. You may still ` +
      'report on other clear relationships you notice, but prioritise the named people.'
    : 'Cover any people whose relationship to each other is reasonably clear from the transcript.';

  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 2000,
    ...THINKING_PARAM,
    system:
      'You analyse social dynamics and relationships between members of a WhatsApp chat, based ' +
      'purely on how they address and interact with each other in the transcript(s) below (each ' +
      'block is labelled with which chat it came from). Look for signals like: pet names/nicknames, ' +
      'inside jokes, frequent back-and-forth, teasing, affection, emotional support, deference, ' +
      'flirting, terms like "babe"/"honey"/bro/sis, or — on the other end — coldness, sarcasm aimed ' +
      'at someone, being ignored or dogpiled, repeated friction or arguments. ' +
      `${focus}\n\n` +
      'For each pair or group you find a signal for, output one line:\n' +
      '• *Name A* ↔ *Name B* — <relationship guess: e.g. "close friends", "possible couple", ' +
      '"siblings/family", "friction/tension", "one-sided", "no clear signal yet"> — <short evidence ' +
      'quote or paraphrase backing it up>\n\n' +
      'Group the output under two headers: "🤝 Rapport / closeness" and "⚡ Friction / distance". ' +
      'Omit a header entirely if you find nothing for it. Be speculative and hedge appropriately ' +
      '("seems", "appears") — this is a fun/casual read of group dynamics, not a real diagnosis. ' +
      'Do not invent relationships with no textual evidence. If the transcript is too thin to tell ' +
      'anything, say so plainly instead of guessing.',
    messages: [
      {
        role: 'user',
        content: `Here are the chat transcript(s) (oldest to newest within each):\n\n${transcript}`,
      },
    ],
  });
  return textOf(message) || '(No relationship signals found.)';
}

async function summariseMeetup(transcript) {
  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 2048,
    ...THINKING_PARAM,
    system:
      'You extract meet-up and outing plans from WhatsApp group chats. ' +
      'Focus ONLY on content related to: proposed or confirmed outings, ' +
      'dates/times/venues suggested or agreed, who said they can/cannot make it, ' +
      'unresolved questions about the plan, and any action items (e.g. someone ' +
      'needs to book a table). Ignore everything unrelated to meetups or outings. ' +
      'Lead with a one-line status (e.g. "Plan confirmed", "Still being decided"). ' +
      'Then bullet the key details. If there are no meetup-related messages, say so.',
    messages: [
      {
        role: 'user',
        content: `Here is the chat transcript (oldest to newest):\n\n${transcript}`,
      },
    ],
  });
  return textOf(message) || '(No meetup information found.)';
}

async function extractAbsurdComments(transcript) {
  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 2048,
    ...THINKING_PARAM,
    system:
      'You spot absurd, nonsensical, or logically ridiculous comments in a WhatsApp ' +
      'group chat — statements that go against common sense, basic facts, or sound ' +
      'reasoning (exaggerations, contradictions, wild claims, faulty logic). Quote ' +
      "joke/sarcasm only if it's presented as if serious; skip obvious deliberate " +
      'jokes that everyone is clearly in on. For each one found, give: the person\'s ' +
      'name, a short quote or paraphrase of what they said, and a one-line note on ' +
      'why it defies common sense. Keep the tone light and playful, not mean. ' +
      'Format as a bulleted list: *Name*: "quote" — why it\'s absurd. ' +
      'If nothing absurd is found in the transcript, say so plainly.',
    messages: [
      {
        role: 'user',
        content: `Here is the chat transcript (oldest to newest):\n\n${transcript}`,
      },
    ],
  });
  return textOf(message) || '(No absurd comments found.)';
}

// Shared humanizing style rules for anything drafted/sent on the user's
// behalf — kills the usual AI tells instead of pulling in a third-party
// "humanizer" package (those are either paid detector-evasion APIs that ship
// your chats to a stranger's server, or unrelated string-formatting libs).
const HUMAN_STYLE =
  'Write like a real person quickly typing a text on their phone: contractions, plain ' +
  'punctuation, no corporate or AI phrasing. Never use em dashes. Never say things like ' +
  '"I hope this helps", "Certainly!", "Of course!", or other assistant-speak. Skip hedging, ' +
  'filler ("in order to", "at this point in time"), and forced lists of three. Keep it short ' +
  '— one to three sentences, like an actual text, not an essay.';

// Sentinel the model outputs in 'discussion' tone when a message doesn't
// warrant a reply. Checked verbatim in autoReplyMessage() below.
const NO_REPLY_SENTINEL = 'NO_REPLY_NEEDED';

function toneInstruction(tone) {
  if (!tone) return 'Pick a natural tone that fits the message and conversation.';
  if (tone === 'scam') {
    return (
      'The other person messaging is a suspected scammer. Play along as a naive, slightly ' +
      'confused, trusting target to waste their time and string them along — sound ' +
      'hopeful/excited/convinced, ask lots of clarifying questions, stall, and never sound ' +
      'suspicious. NEVER reveal or invent real personal, financial, banking, ID, OTP, ' +
      'password, or address information, even if asked directly — deflect with more ' +
      'stalling questions or a fake technical problem ("my banking app is glitching") ' +
      'instead. This is scambaiting aimed at the scammer, not real information disclosure.'
    );
  }
  if (tone === 'discussion') {
    return (
      'This is a resident committee / community group chat. You participate on behalf of ' +
      'the user, but sparingly. Read the last 20 messages of context as a whole — not just ' +
      'the newest one — and identify the 1-2 most significant live discussion points ' +
      '(proposals, decisions, disputes, or direct open questions). Only draft a reply if ' +
      'you can address one of those points with real authority and high confidence: facts ' +
      'you actually have, not guesses about schedules, policies, costs, or other specifics ' +
      'you do not know. If you would be guessing or speculating, if the question is better ' +
      'left to the committee/management, or if nothing in the recent messages genuinely ' +
      `needs your input, output exactly ${NO_REPLY_SENTINEL} and nothing else — no ` +
      'punctuation, no explanation. When you do reply, be professional, logical, concise, ' +
      'and reason from what is best for the community as a whole, not personal convenience.'
    );
  }
  return `Write in a ${tone} tone.`;
}

async function draftReply(contextTranscript, targetMessage, tone = null) {
  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 300,
    ...THINKING_PARAM,
    system:
      'You draft a reply to a specific WhatsApp message on behalf of the user, using the ' +
      'surrounding conversation only as context for what is going on. ' +
      `${HUMAN_STYLE} ${toneInstruction(tone)} Output ONLY the reply text itself, with no ` +
      'preamble, no quotes around it, and no explanation.',
    messages: [
      {
        role: 'user',
        content:
          `Conversation so far, oldest to newest (context only):\n${contextTranscript || '(no prior context)'}\n\n` +
          `Message to reply to:\n"${targetMessage}"\n\n` +
          'Draft a reply.',
      },
    ],
  });
  return textOf(message) || '(No reply produced.)';
}

// Like draftReply, but for live, unattended auto-reply: sent straight to the
// chat with no review step, so the humanizing + tone/scam guardrails matter
// even more here than in the drafted-for-review path.
async function autoReplyMessage(contextTranscript, incomingMessage, tone = null) {
  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 300,
    ...THINKING_PARAM,
    system:
      'You are auto-replying to an incoming WhatsApp message on behalf of the user, in real ' +
      'time, using the recent conversation only as context. ' +
      `${HUMAN_STYLE} ${toneInstruction(tone)} Output ONLY the reply text itself, with no ` +
      'preamble, no quotes, and no explanation.',
    messages: [
      {
        role: 'user',
        content:
          `Recent conversation, oldest to newest (context only):\n${contextTranscript || '(no prior context)'}\n\n` +
          `New incoming message to reply to:\n"${incomingMessage}"`,
      },
    ],
  });
  const text = textOf(message).trim();
  // 'discussion' tone: model opts out of replying to this specific message.
  if (tone === 'discussion' && text.toUpperCase() === NO_REPLY_SENTINEL) return null;
  return text || '(No reply produced.)';
}

async function ask(userMessage) {
  const message = await createWithRetry({
    model: MODEL,
    max_tokens: 1024,
    ...THINKING_PARAM,
    system:
      'You are a helpful assistant replying inside a WhatsApp chat. Keep answers ' +
      'short, friendly, and conversational — suitable for a chat message, not an ' +
      'essay. Use plain text (WhatsApp supports *bold*, _italics_, and ```code```).',
    messages: [{ role: 'user', content: userMessage }],
  });
  return textOf(message) || '(No reply produced.)';
}

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
  isOverloaded,
  MODEL,
};
