// Claude integration — summarisation and conversational replies.
// Uses the official Anthropic SDK. The API key is read from ANTHROPIC_API_KEY.
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

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

async function summariseByPerson(transcript) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    ...THINKING_PARAM,
    system:
      'You summarise WhatsApp group chats on a per-person basis. ' +
      'For each person who spoke, write a short section (2-5 bullet points) ' +
      'capturing what they said, asked, or contributed. ' +
      'Use the format:\n\n*Name*\n• ...\n• ...\n\n' +
      'Order people by how much they contributed (most first). ' +
      'Be concise and neutral. Do not invent anything not in the transcript.',
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

module.exports = { summariseTranscript, summariseByPerson, summariseMeetup, ask, MODEL };
