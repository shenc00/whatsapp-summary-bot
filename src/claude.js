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

async function summariseTranscript(transcript) {
  const message = await client.messages.create({
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

  const message = await client.messages.create({
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

async function summariseMeetup(transcript) {
  const message = await client.messages.create({
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
  const message = await client.messages.create({
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

async function ask(userMessage) {
  const message = await client.messages.create({
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
  summariseMeetup,
  extractAbsurdComments,
  ask,
  MODEL,
};
