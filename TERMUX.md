# Running the bot on Android (Termux)

You can run this bot directly on an Android phone using **Termux** (a Linux terminal app). Because you can't scan an on-screen QR with the same phone's camera, this setup links by **pairing code** instead.

> Use your phone's **mobile data or home Wi-Fi** — not a corporate network that blocks/inspects WhatsApp.

## 1. Install Termux

Install Termux from **F-Droid** — NOT the Google Play version (it's outdated and broken):
https://f-droid.org/packages/com.termux/

Open it, then:

```bash
pkg update && pkg upgrade -y
pkg install nodejs git -y
```

## 2. Install Chromium

Puppeteer's bundled Chromium doesn't run on Android, so install Termux's:

```bash
pkg install tur-repo -y
pkg install chromium -y
chromium --version   # confirm it works
```

## 3. Get the code

```bash
git clone <YOUR_GITHUB_REPO_URL> whatsapp-summary-bot
cd whatsapp-summary-bot
```

## 4. Install dependencies (skip the Chromium download)

```bash
export PUPPETEER_SKIP_DOWNLOAD=true
npm install
```

## 5. Configure `.env`

```bash
cp .env.example .env
nano .env
```

Set these (Ctrl-O to save, Ctrl-X to exit nano):

```
ANTHROPIC_API_KEY=sk-ant-api03-...your real key...
CLAUDE_MODEL=claude-haiku-4-5
CHROME_PATH=/data/data/com.termux/files/usr/bin/chromium
PAIRING_PHONE_NUMBER=6591234567        # your WhatsApp number, digits only, with country code
```

## 6. Start it

```bash
termux-wake-lock   # keep the phone from suspending the process
npm start
```

An **8-character pairing code** prints in the terminal. Then on WhatsApp:

**Settings → Linked Devices → Link a Device → "Link with phone number instead" → enter the code.**

You'll see `✅ Bot is ready!`. Now message any chat with `!help`, `!summary 50`, etc.

## Keeping it running

- Termux must stay open. Pull down the Termux notification and tap **Acquire wakelock**, and in Android settings disable **battery optimization** for Termux.
- Chromium is heavy on a phone — expect higher battery/RAM use. A phone with ≥4 GB RAM handles it best.
- If Android kills the process, just run `npm start` again (you won't need to re-link — the session is saved in `.wwebjs_auth/`).

## Troubleshooting

- **`Failed to launch the browser process`** → re-check `CHROME_PATH` points at the Termux chromium (`which chromium`).
- **Pairing code rejected** → make sure `PAIRING_PHONE_NUMBER` is full international format, digits only (e.g. `6591234567`, no `+`, no spaces).
- **Crashes under memory pressure** → close other apps; Chromium needs free RAM.
