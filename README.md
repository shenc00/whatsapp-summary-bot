# WhatsApp Summary Bot

A personal WhatsApp bot that **summarises group-chat discussions** and can **auto-reply** to messages, powered by [Claude](https://www.anthropic.com/).

It links to your existing WhatsApp account through the same **"Linked Devices"** QR-code flow you use for WhatsApp Web — no separate number or business account needed.

| Command | What it does |
|---|---|
| `!summary [N]` | Summarises the last `N` messages in the chat (default 50) |
| `!ai <question>` | Asks Claude a one-off question |
| `!autoreply on` / `off` | Turns automatic replies on/off **for that chat** |
| `!help` | Lists the commands |

---

## ⚠️ Read first

This uses [`whatsapp-web.js`](https://wwebjs.dev/), which automates **WhatsApp Web** by driving a real browser session. It is **not** an official WhatsApp API. That means:

- It is **against WhatsApp's Terms of Service** to automate a personal account, and there is a real (if small for light personal use) **risk your number gets banned**. Use a number you're willing to risk, and keep auto-reply usage light and human-like.
- Your computer must stay **running and online** for the bot to work (it's an active WhatsApp Web session).
- For anything commercial or high-volume, use the official [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp) instead.

---

## Prerequisites

1. **Node.js 18 or newer** — check with `node -v`. Install from [nodejs.org](https://nodejs.org/) if needed.
2. **An Anthropic API key** — from the [Anthropic Console](https://console.anthropic.com/) → *Settings → API Keys*.
3. **A phone with WhatsApp** that you'll keep the bot linked to.

---

## Step-by-step setup

### 1. Get the code & install dependencies

```bash
cd "whatsapp-summary-bot"
npm install
```

> The first install downloads a bundled Chromium (~150 MB) used to run WhatsApp Web — give it a minute.

### 2. Add your API key

```bash
# copy the template, then edit .env
cp .env.example .env
```

Open `.env` and paste your Anthropic key after `ANTHROPIC_API_KEY=`.

### 3. Start the bot

```bash
npm start
```

A **QR code** appears in your terminal.

### 4. Link it to your WhatsApp

On your phone:

1. Open **WhatsApp**.
2. Tap **⋮ / Settings → Linked Devices**.
3. Tap **Link a Device**.
4. **Scan the QR code** shown in your terminal.

You'll see `✅ Bot is ready!` once it connects. The session is saved locally (in `.wwebjs_auth/`), so you only scan once — restarts reconnect automatically.

### 5. Use it

In **any chat the linked account is part of**, type:

```
!summary 100      → summary of the last 100 messages
!ai what's the weather like to discuss?
!autoreply on     → Claude now replies to incoming messages in this chat
!autoreply off    → stop auto-replying
!help
```

Because the bot is *your* account, you can type these commands yourself from your own phone — the bot sees them and responds.

---

## Tips

- **Keep it cheap:** set `CLAUDE_MODEL=claude-haiku-4-5` in `.env` for fast, low-cost auto-replies; keep `claude-opus-4-8` for the best summaries.
- **Auto-reply is per-chat and opt-in** so the bot never spams every conversation. It's stored in `autoreply.json`.
- **Run it 24/7** on a spare laptop, a Raspberry Pi, or a small cloud VM. Keep the machine awake.
- **Logging out:** remove the device from *Linked Devices* on your phone, and delete the `.wwebjs_auth/` folder.

---

## How it works

```
WhatsApp (your phone)
        │  Linked Devices (QR)
        ▼
whatsapp-web.js  ──fetch messages──►  build transcript
        │                                    │
        │                                    ▼
        │                          Claude (@anthropic-ai/sdk)
        │                                    │
        ◄────────── reply / summary ─────────┘
```

- `src/index.js` — WhatsApp client, command routing, auto-reply.
- `src/claude.js` — Claude calls (summarise + reply).

## License

MIT — personal use, at your own risk re: WhatsApp's ToS.
