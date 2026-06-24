require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { summariseTranscript, summariseByPerson, summariseMeetup, ask, MODEL } = require('./claude');

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
  console.log('   Commands: !summary · !personal · !meetup · !ai · !autoreply · !help');
});

// ---------------------------------------------------------------------------
// Private reply helper.
// Deletes the command message from the chat and sends the result only to the
// user's own "Saved Messages" chat — invisible to everyone else.
// ---------------------------------------------------------------------------
async function replyPrivate(msg, text) {
  // Delete the command message so others don't see it was triggered.
  try {
    await msg.delete(true);
  } catch {
    // Ignore — message may already be gone or outside the delete window.
  }
  // Send the result to the user's own saved-messages / self-chat.
  const selfId = client.info.wid._serialized;
  await client.sendMessage(selfId, text);
}

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

// ---------------------------------------------------------------------------
// Commands. Triggered by message_create so your own typed commands are caught.
// All results are delivered privately to your Saved Messages.
// ---------------------------------------------------------------------------
client.on('message_create', async (msg) => {
  const body = (msg.body || '').trim();
  if (!body.startsWith('!')) return;

  // Only respond to commands typed by the bot account owner (you), not others.
  if (!msg.fromMe) return;

  try {
    const chat = await msg.getChat();
    const [cmd, ...rest] = body.split(/\s+/);
    const command = cmd.toLowerCase();

    if (['!summary', '!summarise', '!summarize'].includes(command)) {
      const n = parseInt(rest[0], 10) || DEFAULT_SUMMARY_COUNT;
      await chat.sendStateTyping();
      const messages = await chat.fetchMessages({ limit: n });
      const transcript = await buildTranscript(messages);
      if (!transcript) {
        await replyPrivate(msg, '_(Nothing to summarise — no recent text messages found.)_');
        return;
      }
      const summary = await summariseTranscript(transcript);
      await replyPrivate(msg, `📋 *Summary of the last ${messages.length} messages*\n_(from: ${chat.name || 'chat'})_\n\n${summary}`);

    } else if (['!personal', '!whosaid'].includes(command)) {
      const n = parseInt(rest[0], 10) || DEFAULT_SUMMARY_COUNT;
      await chat.sendStateTyping();
      const messages = await chat.fetchMessages({ limit: n });
      const transcript = await buildTranscript(messages);
      if (!transcript) {
        await replyPrivate(msg, '_(Nothing to summarise — no recent text messages found.)_');
        return;
      }
      const summary = await summariseByPerson(transcript);
      await replyPrivate(msg, `👥 *Who said what — last ${messages.length} messages*\n_(from: ${chat.name || 'chat'})_\n\n${summary}`);

    } else if (command === '!meetup') {
      const n = parseInt(rest[0], 10) || DEFAULT_SUMMARY_COUNT;
      await chat.sendStateTyping();
      const messages = await chat.fetchMessages({ limit: n });
      const transcript = await buildTranscript(messages);
      if (!transcript) {
        await replyPrivate(msg, '_(No messages found.)_');
        return;
      }
      const summary = await summariseMeetup(transcript);
      await replyPrivate(msg, `📅 *Meetup/outing summary — last ${messages.length} messages*\n_(from: ${chat.name || 'chat'})_\n\n${summary}`);

    } else if (command === '!ai') {
      const question = rest.join(' ').trim();
      if (!question) {
        await replyPrivate(msg, 'Usage: !ai <your question>');
        return;
      }
      await chat.sendStateTyping();
      const reply = await ask(question);
      await replyPrivate(msg, reply);

    } else if (command === '!autoreply') {
      const arg = (rest[0] || '').toLowerCase();
      const id = chat.id._serialized;
      if (arg === 'on') {
        autoReplyChats.add(id);
        saveState();
        await replyPrivate(msg, `🤖 Auto-reply *enabled* for: ${chat.name || 'this chat'}`);
      } else if (arg === 'off') {
        autoReplyChats.delete(id);
        saveState();
        await replyPrivate(msg, `🤖 Auto-reply *disabled* for: ${chat.name || 'this chat'}`);
      } else {
        await replyPrivate(msg, 'Usage: !autoreply on | off');
      }

    } else if (command === '!help') {
      await replyPrivate(
        msg,
        '*WhatsApp Summary Bot*\n' +
          '• `!summary [N]` — overall summary of last N messages\n' +
          '• `!personal [N]` — per-person breakdown of last N messages\n' +
          '• `!meetup [N]` — extract meetup/outing plans from last N messages\n' +
          '• `!ai <question>` — ask Claude anything\n' +
          '• `!autoreply on|off` — toggle auto-replies in this chat\n' +
          '• `!help` — show this message\n\n' +
          '_All results are sent privately to your Saved Messages. Default N = ' + DEFAULT_SUMMARY_COUNT + '._'
      );
    }
  } catch (err) {
    console.error('Command error:', err);
    try {
      await replyPrivate(msg, '⚠️ Something went wrong handling that command.');
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
