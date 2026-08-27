#!/usr/bin/env bash
# Daily disk reclaim: docker build cache, dangling images, dead WhatsApp
# sessions. Cron: 0 4 * * * (after the 3am ktmb DB backup).
# Quiet by default — only reports to Telegram when it actually freed something
# worth knowing about, so it does not become a daily notification to ignore.
# ponytail: prunes on a timer, not on a disk-usage threshold. Add a
# `df` guard here if the box ever fills faster than daily.
set -uo pipefail

NOTIFY_MIN_MB=500
STALE_SESSION_AGE_DAYS=7
BOT_DIR=/home/ubuntu/whatsapp-summary-bot

set -a; . /home/ubuntu/ktmb-ticket-monitor/.env 2>/dev/null; set +a

before=$(df --output=avail -m / | tail -1 | tr -dc 0-9)

# Keep the last week of build cache: pruning everything makes the next ktmb
# rebuild crawl, and the cache costs disk we are not short of.
docker builder prune -af --filter until=168h >/dev/null 2>&1
docker image prune -f >/dev/null 2>&1

# Sessions moved aside during a failed re-link. Once a week old they are not
# coming back — the live session lives in .wwebjs_auth, which is untouched.
find "$BOT_DIR" -maxdepth 1 -name '.wwebjs_auth.stale.*' -type d \
  -mtime +$STALE_SESSION_AGE_DAYS -exec rm -rf {} + 2>/dev/null

pm2 flush >/dev/null 2>&1

after=$(df --output=avail -m / | tail -1 | tr -dc 0-9)
freed=$(( after - before ))

if [ "$freed" -ge "$NOTIFY_MIN_MB" ]; then
  curl -sS --max-time 15 -o /dev/null \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d text="🧹 Daily cleanup freed ${freed} MB. Disk now ${after} MB free." || true
fi
