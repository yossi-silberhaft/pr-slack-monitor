# pr-slack-monitor

Get Slack pings when activity happens on PRs that matter to you, plus a daily
digest of everything still open. Runs as two cron jobs against the GitHub API.

You'll get notified for:

- ✅ Approvals on PRs you authored
- 🔄 Change requests on PRs you authored
- 👀 Reviews requested from you
- 💬 Human comments on PRs you authored or are reviewing
- 📋 A daily summary listing every open PR assigned to you, requested of you, or authored by you

## Quick install

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/yossi-silberhaft/pr-slack-monitor/master/install.sh)"
```

The installer clones into `~/.pr-slack-monitor`, then runs `setup.sh` which
prompts for your secrets, writes `.env`, runs a smoke test, and offers to
install the cron entries for you.

## Manual install

```sh
git clone https://github.com/yossi-silberhaft/pr-slack-monitor.git ~/.pr-slack-monitor
cd ~/.pr-slack-monitor
./setup.sh
```

## What you'll need

### 1. A GitHub personal access token

Create one at https://github.com/settings/tokens.

**Classic token** — pick the smallest scope that covers your repos:

| Scope         | When to use it                                                |
| ------------- | ------------------------------------------------------------- |
| `repo`        | You want notifications on private repos (the common case).    |
| `public_repo` | You only care about public repos.                             |

**Fine-grained token** — repository access: *All repositories* (or pick the
ones you care about). Permissions:

| Permission       | Access |
| ---------------- | ------ |
| Pull requests    | Read   |
| Issues           | Read   |
| Metadata         | Read (auto-selected) |

Expiry: whatever your org policy requires — just remember to rotate it.

### 2. A Slack incoming webhook URL

Recommended setup: create a **private channel just for yourself**, e.g.
`#${yourName}-alerts` (`#jane-alerts`, `#yossi-alerts`, …), and attach the
webhook to that channel. That way nobody else gets pinged and you can mute /
configure notifications independently.

Create the webhook at https://api.slack.com/messaging/webhooks and point it at
your private channel. **If you need help creating the webhook, reach out.**

### 3. Node 18+ on your PATH

## How it's wired up

`setup.sh` writes two cron entries by default:

| Job      | Schedule         | What it does                                              |
| -------- | ---------------- | --------------------------------------------------------- |
| realtime | every 5 min      | Checks for new approvals / change requests / review requests / comments and sends them as one batched Slack message. |
| summary  | weekdays at 9am  | Posts a digest of all your open PRs, grouped by repo.     |

Edit `crontab -e` to change the schedules. The entries are tagged with
`# pr-slack-monitor:realtime` and `# pr-slack-monitor:summary` so they're easy
to find.

Logs land in `realtime.log` and `summary.log` in the install dir.

## Configuration

All config lives in `.env` (gitignored, `chmod 600`). See `.env.example` for
the full list. The variables:

| Variable                | Required | Notes                                                  |
| ----------------------- | -------- | ------------------------------------------------------ |
| `PR_MONITOR_GH_TOKEN`   | yes      | GitHub PAT                                             |
| `SLACK_WEBHOOK_URL`     | yes      | Slack incoming webhook                                 |
| `GITHUB_USERNAME`       | yes      | Your GitHub login                                      |
| `NODE_BIN`              | yes      | Absolute path to `node`. Auto-detected by `setup.sh`.  |

State (which reviews/comments have already been notified) is stored in
`.pr-monitor-state.json` — also gitignored.

## Updating

```sh
cd ~/.pr-slack-monitor
git pull
```

No need to re-run `setup.sh` unless the config schema changes.

## Uninstall

```sh
crontab -e  # remove the two pr-slack-monitor lines
rm -rf ~/.pr-slack-monitor
```

Then revoke the GitHub token at https://github.com/settings/tokens and delete
the Slack webhook in your Slack app config.
