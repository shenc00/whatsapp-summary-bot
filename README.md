# WhatsApp Summary Bot

A personal WhatsApp bot that **summarises group-chat discussions** and can **auto-reply** to messages, powered by [Claude](https://www.anthropic.com/).

It links to your existing WhatsApp account through the same **"Linked Devices"** QR-code flow you use for WhatsApp Web — no separate number or business account needed.

**All commands are typed in your own "Saved Messages" chat — never in the group/contact chat itself.** This is deliberate: WhatsApp always shows "This message was deleted" to other members when you delete-for-everyone, so there's no way to type a command *in* a group and truly erase the trace. Keeping commands confined to Saved Messages means nothing is ever posted to (or deleted from) any other chat — zero footprint, by construction.

| Command | What it does |
|---|---|
| `!chats [filter]` | Lists your chats with a number, e.g. `2. Family Group`. Use that number in the commands below. |
| `!summary <chat#> [N]` | Summarises the last `N` messages in that chat (default 50) |
| `!personal <chat#> [N]` | Per-person breakdown of who said what |
| `!personal <chat#> <name> [N]` | Summarises just that one person's contributions |
| `!profile <chat#[,chat#,...]> <name> [N]` | Speculative personality/character profile for that person (age range, traits, style), combined across one or more chats they're in |
| `!relationships <chat#[,chat#,...]> [name1,name2,...] [N]` | Speculative rapport/closeness and friction/tension signals between members, across one or more chats |
| `!meetup <chat#> [N]` | Extracts meet-up/outing plans (dates, venues, who's in/out) |
| `!absurd <chat#> [N]` | Flags absurd or illogical comments, naming who said them |
| `!ai <question>` | Asks Claude a one-off question (no chat needed) |
| `!autoreply <chat#> on` / `off` | Turns automatic replies on/off **for that chat** |
| `!help` | Lists the commands |

Chat numbers come from your most recent `!chats` call and are cached in memory until you run it again (or the bot restarts).

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

Open your own **Saved Messages** chat (search "You" in WhatsApp, or message yourself) and type:

```
!chats                      → list your chats with numbers
!chats family                → same, filtered to chats containing "family"

!summary 2 100               → summary of the last 100 messages in chat #2
!personal 2 100              → per-person breakdown of the last 100 messages
!personal 2 Alice 100        → just Alice's contributions from the last 100 messages
!profile 2 Alice 100         → speculative personality profile for Alice from the last 100 messages
!profile 2,5 Alice 100        → same, but combining Alice's messages from chats #2 and #5
!relationships 2 100          → rapport/friction signals between members of chat #2
!relationships 2,5 Alice,Bob 100 → same, focused on Alice and Bob, across chats #2 and #5
!meetup 2 100                → meet-up/outing plans pulled from the last 100 messages
!absurd 2 100                → absurd/illogical comments, with names, from the last 100 messages
!ai what's the weather like to discuss?
!autoreply 2 on              → Claude now replies to incoming messages in chat #2
!autoreply 2 off             → stop auto-replying
!help
```

Because the bot is *your* account, you can type these commands yourself from your own phone. The bot only reacts to commands typed in Saved Messages and replies there too — it never touches the group/contact chat you're asking about.

---

## Tips

- **Keep it cheap:** set `CLAUDE_MODEL=claude-haiku-4-5` in `.env` for fast, low-cost auto-replies; keep `claude-opus-4-8` for the best summaries.
- **Auto-reply is per-chat and opt-in** so the bot never spams every conversation. It's stored in `autoreply.json`.
- **Run it 24/7** on a spare laptop, a Raspberry Pi, or a small cloud VM. Keep the machine awake.
- **Logging out:** remove the device from *Linked Devices* on your phone, and delete the `.wwebjs_auth/` folder.
- **Chrome not found?** If Puppeteer can't download/launch its bundled Chromium, set `CHROME_PATH` in `.env` to a Chrome/Edge already installed on your machine (see `.env.example` for OS-specific paths).
- **"Claude is overloaded" message:** the bot already retries overload errors several times with backoff; if it still fails, Anthropic's API is having a busy moment — just retry the command after a minute.

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
