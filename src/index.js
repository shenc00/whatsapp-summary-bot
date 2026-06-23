require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { summariseTranscript, ask, MODEL } = require('./claude');

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
    // Use a system-installed Chrome/Edge if CHROME_PATH is set; otherwise fall
    // back to Puppeteer's bundled Chromium.
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

let pairingRequested = false;
client.on('qr', async (qr) => {
  // If a phone number is configured, link by pairing CODE instead of QR.
  // Use this when the bot runs on the same phone you're linking (you can't
  // scan an on-screen QR with that phone's own camera).
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
  console.log('   Commands: !summary [N] · !ai <question> · !autoreply on|off · !help');
});

// Build a "Name: message" transcript from a list of wwebjs messages.
async function buildTranscript(messages) {
  const lines = [];
  for (const m of messages) {
    if (!m.body) continue; // skip media / system messages with no text
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
// Commands. We listen on `message_create` so they work whether YOU type them
// or someone else does. Anything starting with "!" is treated as a command.
// ---------------------------------------------------------------------------
client.on('message_create', async (msg) => {
  const body = (msg.body || '').trim();
  if (!body.startsWith('!')) return;

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
        await chat.sendMessage('Nothing to summarise — no recent text messages found.');
        return;
      }
      const summary = await summariseTranscript(transcript);
      await chat.sendMessage(`📋 *Summary of the last ${messages.length} messages*\n\n${summary}`);
    } else if (command === '!ai') {
      const question = rest.join(' ').trim();
      if (!question) {
        await chat.sendMessage('Usage: !ai <your question>');
        return;
      }
      await chat.sendStateTyping();
      await chat.sendMessage(await ask(question));
    } else if (command === '!autoreply') {
      const arg = (rest[0] || '').toLowerCase();
      const id = chat.id._serialized;
      if (arg === 'on') {
        autoReplyChats.add(id);
        saveState();
        await chat.sendMessage('🤖 Auto-reply *enabled* for this chat.');
      } else if (arg === 'off') {
        autoReplyChats.delete(id);
        saveState();
        await chat.sendMessage('🤖 Auto-reply *disabled* for this chat.');
      } else {
        await chat.sendMessage('Usage: !autoreply on | off');
      }
    } else if (command === '!help') {
      await chat.sendMessage(
        '*WhatsApp Summary Bot*\n' +
          '• `!summary [N]` — summarise the last N messages (default ' + DEFAULT_SUMMARY_COUNT + ')\n' +
          '• `!ai <question>` — ask Claude anything\n' +
          '• `!autoreply on|off` — toggle auto-replies in this chat\n' +
          '• `!help` — show this message'
      );
    }
  } catch (err) {
    console.error('Command error:', err);
    try {
      const chat = await msg.getChat();
      await chat.sendMessage('⚠️ Something went wrong handling that command.');
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Auto-reply. Fires only for INCOMING messages (the `message` event), and only
// in chats where auto-reply has been switched on. Commands are ignored here.
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
