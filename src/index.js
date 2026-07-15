require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const {
  summariseTranscript,
  summariseByPerson,
  profilePerson,
  analyseRelationships,
  summariseMeetup,
  extractAbsurdComments,
  draftReply,
  ask,
  isOverloaded,
  MODEL,
} = require('./claude');

const REPLY_TONES = ['casual', 'formal', 'funny', 'firm', 'warm', 'blunt', 'apologetic', 'assertive', 'playful', 'professional'];
const REPLY_CONTEXT_COUNT = 10;

if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('...')) {
  console.error('❌ ANTHROPIC_API_KEY is missing or still the placeholder. Edit .env and paste your real key from https://console.anthropic.com/');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Persisted state: which chats have auto-reply switched on.
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(__dirname, '..', 'autoreply.json');
let autoReplyChats = new Set();
try {
  autoReplyChats = new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
} catch {
  /* no state file yet — start empty */
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...autoReplyChats]));
}

const DEFAULT_SUMMARY_COUNT = parseInt(process.env.SUMMARY_MESSAGE_COUNT, 10) || 50;

// ---------------------------------------------------------------------------
// WhatsApp client. LocalAuth keeps the session on disk so you only scan once.
// ---------------------------------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
  puppeteer: {
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

let pairingRequested = false;
client.on('qr', async (qr) => {
  const phone = (process.env.PAIRING_PHONE_NUMBER || '').replace(/[^0-9]/g, '');
  if (phone) {
    if (pairingRequested) return;
    pairingRequested = true;
    try {
      const code = await client.requestPairingCode(phone);
      console.log('\n🔗 On WhatsApp: Settings → Linked Devices → Link a Device →');
      console.log('   tap "Link with phone number instead", then enter this code:\n');
      console.log(`        ${code}\n`);
    } catch (err) {
      console.error('❌ Could not get a pairing code:', err.message);
    }
    return;
  }
  console.log('\n📱 Open WhatsApp on another device → Settings → Linked Devices → Link a Device, then scan:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('🔐 Authenticated.'));
client.on('auth_failure', (m) => console.error('❌ Auth failure:', m));
client.on('disconnected', (r) => console.warn('⚠️  Disconnected:', r));
client.on('ready', () => {
  console.log(`✅ Bot is ready! Using model: ${MODEL}`);
  console.log('   Type commands in your own "Saved Messages" chat: !chats · !summary · !personal · !profile · !relationships · !meetup · !absurd · !ai · !autoreply · !help');
});

// ---------------------------------------------------------------------------
// `!chats [filter]` lists chats with a number you reference in other
// commands (e.g. `!summary 2 100`). Cached in memory between commands so the
// numbers stay stable until you run `!chats` again.
// ---------------------------------------------------------------------------
let lastChatList = [];

// Build a "Name: message" transcript from a list of wwebjs messages.
async function buildTranscript(messages) {
  const lines = [];
  for (const m of messages) {
    if (!m.body) continue;
    let name = 'Unknown';
    try {
      const c = await m.getContact();
      name = c.pushname || c.name || c.number || 'Unknown';
    } catch {
      /* ignore contact lookup failures */
    }
    lines.push(`${name}: ${m.body}`);
  }
  return lines.join('\n');
}

// Parses "2,5,7" (or just "2") into chat objects from lastChatList.
// Returns null (and sends a usage message) if any number is invalid.
async function resolveChats(spec) {
  const indices = spec.split(',').map((s) => parseInt(s.trim(), 10));
  const chats = [];
  for (const idx of indices) {
    if (!idx || idx < 1 || idx > lastChatList.length) return null;
    chats.push(lastChatList[idx - 1]);
  }
  return chats;
}

// Fetches + builds a transcript per chat, each labelled with the chat name,
// and concatenates them. Returns { combined, perChatCounts } where
// perChatCounts is [{ name, count }] for the reply label.
async function buildMultiChatTranscript(chats, n) {
  const blocks = [];
  const perChatCounts = [];
  for (const chat of chats) {
    const messages = await chat.fetchMessages({ limit: n });
    const transcript = await buildTranscript(messages);
    perChatCounts.push({ name: chat.name || chat.id.user, count: messages.length });
    if (transcript) {
      blocks.push(`--- Chat: ${chat.name || chat.id.user} ---\n${transcript}`);
    }
  }
  return { combined: blocks.join('\n\n'), perChatCounts };
}

function overloadOrGenericMessage(err) {
  return isOverloaded(err)
    ? '⚠️ Claude is overloaded right now — please try again in a minute.'
    : '⚠️ Something went wrong handling that command.';
}

// ---------------------------------------------------------------------------
// Commands. ONLY processed when typed in your own "Saved Messages" chat, so
// nothing is ever posted to (or deleted from) any group/contact chat — zero
// trace there, by construction, instead of relying on delete-for-everyone
// (which still leaves a "This message was deleted" placeholder for others).
// ---------------------------------------------------------------------------
client.on('message_create', async (msg) => {
  const body = (msg.body || '').trim();
  if (!body.startsWith('!') || !msg.fromMe) return;

  const selfChat = await msg.getChat();
  // Detect "Message Yourself" via the contact's own isMe flag rather than
  // comparing serialized chat IDs — WhatsApp's LID/phone-number-privacy
  // feature can give the same chat different ID formats, so a raw
  // string comparison against client.info.wid can silently fail to match.
  if (selfChat.isGroup) return;
  const selfContact = await selfChat.getContact();
  if (!selfContact.isMe) return;

  try {
    const [cmd, ...rest] = body.split(/\s+/);
    const command = cmd.toLowerCase();

    if (command === '!chats') {
      const filter = rest.join(' ').trim().toLowerCase();
      const chats = await client.getChats();
      lastChatList = (filter ? chats.filter((c) => (c.name || '').toLowerCase().includes(filter)) : chats).slice(0, 30);
      if (!lastChatList.length) {
        await selfChat.sendMessage('_(No matching chats found.)_');
        return;
      }
      const lines = lastChatList.map((c, i) => `${i + 1}. ${c.name || c.id.user}${c.isGroup ? ' (group)' : ''}`);
      await selfChat.sendMessage('*Chats* — use the number in other commands, e.g. `!summary 2 100`:\n\n' + lines.join('\n'));
      return;
    }

    const NEEDS_TARGET = ['!summary', '!summarise', '!summarize', '!personal', '!whosaid', '!meetup', '!absurd', '!ridiculous', '!autoreply', '!reply'];
    const NEEDS_MULTI_TARGET = ['!profile', '!relationship', '!relationships', '!rapport'];
    let targetChat = null;
    let targetChats = null;
    let args = rest;
    if (NEEDS_TARGET.includes(command)) {
      const idx = parseInt(rest[0], 10);
      if (!idx || idx < 1 || idx > lastChatList.length) {
        await selfChat.sendMessage('Run `!chats [filter]` first, then use the listed number, e.g. `!summary 2 100`.');
        return;
      }
      targetChat = lastChatList[idx - 1];
      args = rest.slice(1);
    } else if (NEEDS_MULTI_TARGET.includes(command)) {
      targetChats = await resolveChats(rest[0] || '');
      if (!targetChats) {
        await selfChat.sendMessage('Run `!chats [filter]` first, then use the listed number(s), e.g. `!profile 2,5 Alice 100`.');
        return;
      }
      args = rest.slice(1);
    }

    if (['!summary', '!summarise', '!summarize'].includes(command)) {
      const n = parseInt(args[0], 10) || DEFAULT_SUMMARY_COUNT;
      await selfChat.sendStateTyping();
      const messages = await targetChat.fetchMessages({ limit: n });
      const transcript = await buildTranscript(messages);
      if (!transcript) {
        await selfChat.sendMessage('_(Nothing to summarise — no recent text messages found.)_');
        return;
      }
      const summary = await summariseTranscript(transcript);
      await selfChat.sendMessage(`📋 *Summary of the last ${messages.length} messages*\n_(from: ${targetChat.name || 'chat'})_\n\n${summary}`);

    } else if (['!personal', '!whosaid'].includes(command)) {
      // !personal <chat#> [N]            — breakdown for everyone
      // !personal <chat#> <name> [N]     — just that person's contributions
      const a = [...args];
      let n = DEFAULT_SUMMARY_COUNT;
      if (a.length && /^\d+$/.test(a[a.length - 1])) {
        n = parseInt(a.pop(), 10);
      }
      const personName = a.length ? a.join(' ') : null;

      await selfChat.sendStateTyping();
      const messages = await targetChat.fetchMessages({ limit: n });
      const transcript = await buildTranscript(messages);
      if (!transcript) {
        await selfChat.sendMessage('_(Nothing to summarise — no recent text messages found.)_');
        return;
      }
      const summary = await summariseByPerson(transcript, personName);
      const label = personName
        ? `👤 *${personName} — last ${messages.length} messages*`
        : `👥 *Who said what — last ${messages.length} messages*`;
      await selfChat.sendMessage(`${label}\n_(from: ${targetChat.name || 'chat'})_\n\n${summary}`);

    } else if (command === '!profile') {
      // !profile <chat#[,chat#,...]> <name> [N] — personality/character profile,
      // combined across all listed chats (e.g. `!profile 2,5 Alice 100`)
      const a = [...args];
      let n = DEFAULT_SUMMARY_COUNT;
      if (a.length && /^\d+$/.test(a[a.length - 1])) {
        n = parseInt(a.pop(), 10);
      }
      const personName = a.join(' ').trim();
      if (!personName) {
        await selfChat.sendMessage('Usage: `!profile <chat#[,chat#,...]> <name> [N]`');
        return;
      }

      await selfChat.sendStateTyping();
      const { combined, perChatCounts } = await buildMultiChatTranscript(targetChats, n);
      if (!combined) {
        await selfChat.sendMessage('_(Nothing to profile — no recent text messages found.)_');
        return;
      }
      const profile = await profilePerson(combined, personName);
      const sourceLine = perChatCounts.map((c) => `${c.name} (${c.count})`).join(', ');
      await selfChat.sendMessage(
        `🧠 *Personality profile*\n_(from: ${sourceLine})_\n` +
          '_(Speculative, based only on chat text — not a real assessment.)_\n\n' +
          profile
      );

    } else if (['!relationship', '!relationships', '!rapport'].includes(command)) {
      // !relationships <chat#[,chat#,...]> [name1, name2, ...] [N]
      // Detects rapport/closeness and friction/tension between members,
      // across one or more chats (e.g. `!relationships 2,5 100`).
      const a = [...args];
      let n = DEFAULT_SUMMARY_COUNT;
      if (a.length && /^\d+$/.test(a[a.length - 1])) {
        n = parseInt(a.pop(), 10);
      }
      const names = a.join(' ').split(',').map((s) => s.trim()).filter(Boolean);

      await selfChat.sendStateTyping();
      const { combined, perChatCounts } = await buildMultiChatTranscript(targetChats, n);
      if (!combined) {
        await selfChat.sendMessage('_(Nothing to analyse — no recent text messages found.)_');
        return;
      }
      const analysis = await analyseRelationships(combined, names.length ? names : null);
      const sourceLine = perChatCounts.map((c) => `${c.name} (${c.count})`).join(', ');
      await selfChat.sendMessage(
        `🔗 *Relationship signals*\n_(from: ${sourceLine})_\n` +
          '_(Speculative read of group dynamics — not a real assessment.)_\n\n' +
          analysis
      );

    } else if (command === '!meetup') {
      const n = parseInt(args[0], 10) || DEFAULT_SUMMARY_COUNT;
      await selfChat.sendStateTyping();
      const messages = await targetChat.fetchMessages({ limit: n });
      const transcript = await buildTranscript(messages);
      if (!transcript) {
        await selfChat.sendMessage('_(No messages found.)_');
        return;
      }
      const summary = await summariseMeetup(transcript);
      await selfChat.sendMessage(`📅 *Meetup/outing summary — last ${messages.length} messages*\n_(from: ${targetChat.name || 'chat'})_\n\n${summary}`);

    } else if (['!absurd', '!ridiculous'].includes(command)) {
      const n = parseInt(args[0], 10) || DEFAULT_SUMMARY_COUNT;
      await selfChat.sendStateTyping();
      const messages = await targetChat.fetchMessages({ limit: n });
      const transcript = await buildTranscript(messages);
      if (!transcript) {
        await selfChat.sendMessage('_(No messages found.)_');
        return;
      }
      const summary = await extractAbsurdComments(transcript);
      await selfChat.sendMessage(`🤡 *Absurd comments — last ${messages.length} messages*\n_(from: ${targetChat.name || 'chat'})_\n\n${summary}`);

    } else if (command === '!ai') {
      const question = rest.join(' ').trim();
      if (!question) {
        await selfChat.sendMessage('Usage: !ai <your question>');
        return;
      }
      await selfChat.sendStateTyping();
      const reply = await ask(question);
      await selfChat.sendMessage(reply);

    } else if (command === '!autoreply') {
      const arg = (args[0] || '').toLowerCase();
      const id = targetChat.id._serialized;
      if (arg === 'on') {
        autoReplyChats.add(id);
        saveState();
        await selfChat.sendMessage(`🤖 Auto-reply *enabled* for: ${targetChat.name || 'this chat'}`);
      } else if (arg === 'off') {
        autoReplyChats.delete(id);
        saveState();
        await selfChat.sendMessage(`🤖 Auto-reply *disabled* for: ${targetChat.name || 'this chat'}`);
      } else {
        await selfChat.sendMessage('Usage: !autoreply <chat#> on | off');
      }

    } else if (command === '!reply') {
      const a = [...args];
      let tone = null;
      if (a.length && REPLY_TONES.includes(a[a.length - 1].toLowerCase())) {
        tone = a.pop().toLowerCase();
      }
      const pastedText = a.join(' ').trim();

      await selfChat.sendStateTyping();
      const messages = await targetChat.fetchMessages({ limit: REPLY_CONTEXT_COUNT });
      const contextTranscript = await buildTranscript(messages);

      let targetMessage = pastedText;
      if (!targetMessage) {
        const lastIncoming = [...messages].reverse().find((m) => !m.fromMe && m.body);
        if (!lastIncoming) {
          await selfChat.sendMessage(
            `_(No incoming message found in the last ${REPLY_CONTEXT_COUNT} messages of that chat — paste the message text instead: \`!reply <chat#> <message>\`.)_`
          );
          return;
        }
        targetMessage = lastIncoming.body;
      }

      const draft = await draftReply(contextTranscript, targetMessage, tone);
      await selfChat.sendMessage(`✍️ *Suggested reply*\n_(to: ${targetChat.name || 'chat'})_\n\n${draft}`);

    } else if (command === '!help') {
      await selfChat.sendMessage(
        '*WhatsApp Summary Bot*\n' +
          'Type commands here, in Saved Messages — nothing is ever posted to or ' +
          'deleted from your other chats.\n\n' +
          '• `!chats [filter]` — list chats with numbers to use below\n' +
          '• `!summary <chat#> [N]` — overall summary of last N messages\n' +
          '• `!personal <chat#> [N]` — per-person breakdown\n' +
          '• `!personal <chat#> <name> [N]` — just that person\'s contributions\n' +
          '• `!profile <chat#[,chat#,...]> <name> [N]` — speculative personality/character profile for that person, combined across chats\n' +
          '• `!relationships <chat#[,chat#,...]> [name1,name2,...] [N]` (alias: `!rapport`) — speculative rapport/friction signals between members; names are optional, omit them to cover everyone\n' +
          '• `!meetup <chat#> [N]` — extract meetup/outing plans\n' +
          '• `!absurd <chat#> [N]` — flag absurd/illogical comments, with names\n' +
          '• `!reply <chat#> [tone]` — draft a reply to the last incoming message in that chat\n' +
          '• `!reply <chat#> <pasted message> [tone]` — draft a reply to that specific message instead\n' +
          `  _(tones: ${REPLY_TONES.join(', ')})_\n` +
          '• `!ai <question>` — ask Claude anything\n' +
          '• `!autoreply <chat#> on|off` — toggle auto-replies in a chat\n' +
          '• `!help` — show this message\n\n' +
          '_Default N = ' + DEFAULT_SUMMARY_COUNT + '. Chat numbers come from your last `!chats`._'
      );
    } else {
      await selfChat.sendMessage(`Unknown command: \`${command}\`. Type \`!help\` for the list of commands.`);
    }
  } catch (err) {
    console.error('Command error:', err.message || err);
    try {
      await selfChat.sendMessage(overloadOrGenericMessage(err));
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Auto-reply. Fires only for INCOMING messages, only in opted-in chats.
// ---------------------------------------------------------------------------
client.on('message', async (msg) => {
  const body = (msg.body || '').trim();
  if (!body || body.startsWith('!')) return;

  try {
    const chat = await msg.getChat();
    if (!autoReplyChats.has(chat.id._serialized)) return;
    await chat.sendStateTyping();
    await chat.sendMessage(await ask(body));
  } catch (err) {
    console.error('Auto-reply error:', err);
  }
});

client.initialize();
