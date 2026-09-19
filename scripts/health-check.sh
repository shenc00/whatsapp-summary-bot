#!/usr/bin/env bash
# VPS health check for ktmb containers + whatsapp bot. Cron: */5 * * * *
# Alerts to Telegram, edge-triggered (one message per state change, not per run).
# ponytail: flat file state, no metrics DB. Add Prometheus only if you ever
# want history/graphs.
set -uo pipefail

STATE=/home/ubuntu/.health-state
HEARTBEAT=/home/ubuntu/whatsapp-summary-bot/.heartbeat
HEARTBEAT_MAX=1800          # 30 min stale = WhatsApp session dead
MEM_MIN_MB=250
DISK_MAX_PCT=85
CONTAINERS="ktmb-ticket-monitor-bot-1 ktmb-ticket-monitor-reserve-and-pay-1 ktmb-ticket-monitor-handoff-user-1-1"

set -a; . /home/ubuntu/ktmb-ticket-monitor/.env 2>/dev/null; set +a

notify() {
  curl -sS --max-time 15 -o /dev/null \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" -d text="$1" || true
}

mkdir -p "$STATE"

# Alerts only on transition: first failure pages, repeats stay quiet, recovery
# pages once. Stops a wedged service from sending 288 messages a day.
report() {           # report <key> <ok|fail> <message>
  local key=$1 status=$2 msg=$3 prev
  prev=$(cat "$STATE/$key" 2>/dev/null || echo ok)
  [ "$status" = "$prev" ] && return
  echo "$status" > "$STATE/$key"
  [ "$status" = fail ] && notify "🔴 $msg" || notify "✅ RECOVERED: $key"
}

for c in $CONTAINERS; do
  health=$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo "missing/missing")
  case "$health" in
    running/healthy|running/none) report "$c" ok "" ;;
    *)                            report "$c" fail "$c is $health" ;;
  esac
done

pm_status=$(pm2 jlist 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((p["pm2_env"]["status"] for p in d if p["name"]=="whatsapp-bot"),"absent"))' 2>/dev/null || echo absent)
if [ "$pm_status" = online ]; then
  report whatsapp-proc ok ""
  # Process alive is not enough: the bot can sit on a QR screen for hours
  # looking online. The heartbeat is the only signal that WhatsApp is linked.
  mtime=$(stat -c %Y "$HEARTBEAT" 2>/dev/null || echo 0)
  age=$(( $(date +%s) - mtime ))
  if [ "$mtime" -eq 0 ] || [ "$age" -gt "$HEARTBEAT_MAX" ]; then
    [ "$mtime" -eq 0 ] && age_txt="never linked since restart" || age_txt="last alive $((age/60))m ago"
    prev_session=$(cat "$STATE/whatsapp-session" 2>/dev/null || echo ok)
    report whatsapp-session fail "whatsapp-bot process online but WhatsApp session is down ($age_txt) - needs re-link"
    # Only auto-restart on the ok->fail transition, not every 5-min tick while
    # still failing - a dead refresh token won't be fixed by restarting, and
    # restarting every cron run would fight a session still mid-reconnect.
    if [ "$prev_session" = ok ]; then
      pm2 restart whatsapp-bot >/dev/null 2>&1
      notify "🔁 auto-restarted whatsapp-bot (stale session)"
    fi
  else
    report whatsapp-session ok ""
  fi
elif [ "$pm_status" = stopped ]; then
  report whatsapp-proc ok ""      # deliberately stopped, not a fault
  report whatsapp-session ok ""
else
  report whatsapp-proc fail "whatsapp-bot pm2 status: $pm_status"
fi

avail=$(free -m | awk '/^Mem:/{print $7}')
[ "$avail" -lt "$MEM_MIN_MB" ] \
  && report mem fail "VPS low memory: ${avail}MB available" \
  || report mem ok ""

disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "$disk" -gt "$DISK_MAX_PCT" ] \
  && report disk fail "VPS disk ${disk}% full" \
  || report disk ok ""
