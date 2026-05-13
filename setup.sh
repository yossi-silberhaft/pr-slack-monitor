#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CRON_TAG_REALTIME="# pr-slack-monitor:realtime"
CRON_TAG_SUMMARY="# pr-slack-monitor:summary"
DEFAULT_CRON_REALTIME="* * * * *"
DEFAULT_CRON_SUMMARY="0 9,16 * * *"

echo
echo "📦 pr-slack-monitor setup"
echo "   installing into: $SCRIPT_DIR"
echo

# --- 1. prereqs --------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "❌ node not found on PATH. Install Node 18+ first (https://nodejs.org)." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_VERSION="$(node --version)"
echo "✅ node $NODE_VERSION at $NODE_BIN"

# --- 2. .env -----------------------------------------------------------------
if [ -f .env ]; then
  printf "⚠️  .env already exists. Overwrite? [y/N] "
  read -r overwrite
  if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
    echo "   keeping existing .env"
    SKIP_ENV=1
  fi
fi

if [ -z "${SKIP_ENV:-}" ]; then
  echo
  echo "🔑 GitHub personal access token (needs 'repo' scope for private repos,"
  echo "   or 'public_repo' for public-only). Create one at:"
  echo "   https://github.com/settings/tokens"
  printf "   token: "
  read -rs GH_TOKEN
  echo

  echo
  echo "📨 Slack incoming webhook URL. Create one at:"
  echo "   https://api.slack.com/messaging/webhooks"
  printf "   webhook: "
  read -rs SLACK_URL
  echo

  echo
  printf "👤 Your GitHub username: "
  read -r GH_USER

  umask 077
  cat > .env <<EOF
PR_MONITOR_GH_TOKEN=$GH_TOKEN
SLACK_WEBHOOK_URL=$SLACK_URL
GITHUB_USERNAME=$GH_USER
NODE_BIN=$NODE_BIN
EOF
  chmod 600 .env
  echo "✅ wrote .env (chmod 600)"
fi

# --- 3. smoke test -----------------------------------------------------------
echo
printf "🧪 Run a smoke test now (sends the daily summary to Slack)? [Y/n] "
read -r smoke
if [[ ! "$smoke" =~ ^[Nn]$ ]]; then
  if ./run_summary.sh; then
    echo "✅ smoke test passed — check your Slack channel"
  else
    echo "❌ smoke test failed. Fix .env and re-run ./setup.sh" >&2
    exit 1
  fi
fi

# --- 4. crontab --------------------------------------------------------------
echo
printf "⏰ Install cron jobs? [Y/n] "
read -r install_cron
if [[ "$install_cron" =~ ^[Nn]$ ]]; then
  echo "   skipped. To install manually, run: crontab -e  and add:"
  echo "     $DEFAULT_CRON_REALTIME $SCRIPT_DIR/run_realtime.sh >> $SCRIPT_DIR/realtime.log 2>&1 $CRON_TAG_REALTIME"
  echo "     $DEFAULT_CRON_SUMMARY $SCRIPT_DIR/run_summary.sh >> $SCRIPT_DIR/summary.log 2>&1 $CRON_TAG_SUMMARY"
else
  CURRENT_CRON="$(crontab -l 2>/dev/null || true)"
  NEW_CRON="$CURRENT_CRON"

  if ! grep -qF "$CRON_TAG_REALTIME" <<<"$CURRENT_CRON"; then
    NEW_CRON="$NEW_CRON
$DEFAULT_CRON_REALTIME $SCRIPT_DIR/run_realtime.sh >> $SCRIPT_DIR/realtime.log 2>&1 $CRON_TAG_REALTIME"
    echo "   + adding realtime (every minute)"
  else
    echo "   = realtime already installed, leaving it alone"
  fi

  if ! grep -qF "$CRON_TAG_SUMMARY" <<<"$CURRENT_CRON"; then
    NEW_CRON="$NEW_CRON
$DEFAULT_CRON_SUMMARY $SCRIPT_DIR/run_summary.sh >> $SCRIPT_DIR/summary.log 2>&1 $CRON_TAG_SUMMARY"
    echo "   + adding summary (9am and 4pm daily)"
  else
    echo "   = summary already installed, leaving it alone"
  fi

  echo "$NEW_CRON" | sed '/^$/d' | crontab -
  echo "✅ crontab updated. View with: crontab -l"
fi

echo
echo "🎉 done. Edit schedules with: crontab -e"
echo "   logs: $SCRIPT_DIR/realtime.log and $SCRIPT_DIR/summary.log"
