#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${PR_SLACK_MONITOR_REPO:-https://github.com/yossi-silberhaft/pr-slack-monitor.git}"
INSTALL_DIR="${PR_SLACK_MONITOR_DIR:-$HOME/.pr-slack-monitor}"

echo
echo "📦 pr-slack-monitor installer"
echo "   repo: $REPO_URL"
echo "   dir:  $INSTALL_DIR"
echo

for cmd in git node crontab; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ '$cmd' not found on PATH. Install it and re-run." >&2
    exit 1
  fi
done

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "↻ existing install found, pulling latest..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "⬇️  cloning..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
chmod +x setup.sh run_realtime.sh run_summary.sh

# When piped from curl, stdin is the script body — redirect prompts to the
# terminal so `read` works.
if [ -t 0 ]; then
  ./setup.sh
else
  ./setup.sh < /dev/tty
fi
