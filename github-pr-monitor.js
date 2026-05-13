#!/usr/bin/env node

/**
 * GitHub PR Monitor - Split into two modes
 * 
 * Usage:
 *   node github-pr-monitor.js summary  - Send daily summary
 *   node github-pr-monitor.js realtime - Check for approvals/comments/changes
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  GITHUB_TOKEN: process.env.PR_MONITOR_GH_TOKEN || '',
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || '',
  GITHUB_USERNAME: process.env.GITHUB_USERNAME || '',
  STATE_FILE: path.join(__dirname, '.pr-monitor-state.json'),
};

// Mode (passed as command line argument)
const MODE = process.argv[2] || 'realtime';

// State tracking (in-memory + persisted to file)
let STATE = {
  lastChecked: null,
  seenReviews: new Set(),
  seenComments: new Set(),
  seenReviewRequests: new Set(),
};

// Pending notifications collected during a realtime run, sent as a single message
let PENDING = [];

// Validate configuration
function validateConfig() {
  const missing = [];
  if (!CONFIG.GITHUB_TOKEN) missing.push('PR_MONITOR_GH_TOKEN');
  if (!CONFIG.SLACK_WEBHOOK_URL) missing.push('SLACK_WEBHOOK_URL');
  if (!CONFIG.GITHUB_USERNAME) missing.push('GITHUB_USERNAME');

  if (missing.length > 0) {
    console.error('❌ Missing environment variables:');
    missing.forEach((key) => {
      console.error(`   - ${key}`);
    });
    console.error('\n📖 Set these environment variables:');
    console.error('   export PR_MONITOR_GH_TOKEN="your_token"');
    console.error('   export SLACK_WEBHOOK_URL="your_webhook_url"');
    console.error('   export GITHUB_USERNAME="your_github_username"');
    process.exit(1);
  }
}

/**
 * Load state from file
 */
function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
      STATE.seenReviews = new Set(data.seenReviews || []);
      STATE.seenComments = new Set(data.seenComments || []);
      STATE.seenReviewRequests = new Set(data.seenReviewRequests || []);
    }
  } catch (error) {
    console.error('⚠️  Could not load state file:', error.message);
  }
}

/**
 * Save state to file
 */
function saveState() {
  try {
    const data = {
      seenReviews: Array.from(STATE.seenReviews),
      seenComments: Array.from(STATE.seenComments),
      seenReviewRequests: Array.from(STATE.seenReviewRequests),
    };
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('⚠️  Could not save state file:', error.message);
  }
}

/**
 * Make HTTPS request to GitHub API
 */
function makeGitHubRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: path,
      method: method,
      headers: {
        'Authorization': `token ${CONFIG.GITHUB_TOKEN}`,
        'User-Agent': 'GitHub-PR-Monitor',
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    https
      .request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`GitHub API error: ${res.statusCode} ${data}`));
          }
        });
      })
      .on('error', reject)
      .end();
  });
}

/**
 * Fetch open PRs that are relevant to the user:
 * - PRs assigned to the user
 * - PRs where the user is a requested reviewer
 */
async function getRelevantPRs() {
  const queries = [
    `assignee:${CONFIG.GITHUB_USERNAME} is:pr is:open`,
    `review-requested:${CONFIG.GITHUB_USERNAME} is:pr is:open`,
    `author:${CONFIG.GITHUB_USERNAME} is:pr is:open`,
  ];

  const dedup = new Map();
  for (const query of queries) {
    try {
      const path = `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc`;
      const response = await makeGitHubRequest(path);
      for (const item of response.items || []) {
        dedup.set(item.id, item);
      }
    } catch (error) {
      console.error(`❌ Error fetching PRs for query "${query}":`, error.message);
    }
  }
  return Array.from(dedup.values());
}

/**
 * Get reviews for a specific PR
 */
async function getPRReviews(prNumber, repoOwner, repoName) {
  try {
    const path = `/repos/${repoOwner}/${repoName}/pulls/${prNumber}/reviews`;
    const reviews = await makeGitHubRequest(path);
    return Array.isArray(reviews) ? reviews : [];
  } catch (error) {
    console.error(`❌ Error fetching reviews for PR #${prNumber}:`, error.message);
    return [];
  }
}

/**
 * Get comments for a specific PR
 */
async function getPRComments(prNumber, repoOwner, repoName) {
  try {
    const path = `/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`;
    const comments = await makeGitHubRequest(path);
    return Array.isArray(comments) ? comments : [];
  } catch (error) {
    console.error(`❌ Error fetching comments for PR #${prNumber}:`, error.message);
    return [];
  }
}

/**
 * Get timeline events for a PR (used to detect review re-requests)
 */
async function getPRTimeline(prNumber, repoOwner, repoName) {
  try {
    const path = `/repos/${repoOwner}/${repoName}/issues/${prNumber}/timeline?per_page=100`;
    const events = await makeGitHubRequest(path);
    return Array.isArray(events) ? events : [];
  } catch (error) {
    console.error(`❌ Error fetching timeline for PR #${prNumber}:`, error.message);
    return [];
  }
}

/**
 * Send message to Slack
 */
function sendSlackMessage(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.SLACK_WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
      },
    };

    https
      .request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Slack error: ${res.statusCode} ${data}`));
          }
        });
      })
      .on('error', reject)
      .end(JSON.stringify(payload));
  });
}

/**
 * Parse owner/repo from PR URL
 */
function parseRepoInfo(url) {
  const parts = url.replace('https://api.github.com/repos/', '').split('/');
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Notify on PR approval
 */
async function notifyOnApproval(review, pr) {
  const reviewId = `${pr.number}-review-${review.id}`;

  if (STATE.seenReviews.has(reviewId)) {
    return;
  }

  if (review.state !== 'APPROVED') {
    return;
  }

  // Only notify on approvals of PRs authored by the user.
  if (!pr.user || pr.user.login !== CONFIG.GITHUB_USERNAME) {
    STATE.seenReviews.add(reviewId);
    return;
  }

  STATE.seenReviews.add(reviewId);

  PENDING.push({
    category: 'approved',
    repo: pr.repository_url.split('/').slice(-1)[0],
    line: `<${pr.html_url}|#${pr.number} - ${pr.title}> by ${review.user.login}`,
    log: `✅ Queued: PR #${pr.number} approved by ${review.user.login}`,
  });
}

/**
 * Notify on change requests
 */
async function notifyOnChangeRequest(review, pr) {
  const reviewId = `${pr.number}-review-${review.id}`;

  if (STATE.seenReviews.has(reviewId)) {
    return;
  }

  if (review.state !== 'CHANGES_REQUESTED') {
    return;
  }

  STATE.seenReviews.add(reviewId);

  PENDING.push({
    category: 'changes_requested',
    repo: pr.repository_url.split('/').slice(-1)[0],
    line: `<${pr.html_url}|#${pr.number} - ${pr.title}> by ${review.user.login}`,
    log: `🔄 Queued: Changes requested on PR #${pr.number} by ${review.user.login}`,
  });
}

/**
 * Notify on review re-request (timeline event: review_requested)
 */
async function notifyOnReviewRequest(event, pr) {
  if (event.event !== 'review_requested') return;

  const requestedLogin = event.requested_reviewer && event.requested_reviewer.login;
  if (requestedLogin !== CONFIG.GITHUB_USERNAME) return;

  const eventId = `${pr.number}-event-${event.id}`;
  if (STATE.seenReviewRequests.has(eventId)) return;
  STATE.seenReviewRequests.add(eventId);

  const requester = (event.actor && event.actor.login) || 'someone';
  PENDING.push({
    category: 'review_requested',
    repo: pr.repository_url.split('/').slice(-1)[0],
    line: `<${pr.html_url}|#${pr.number} - ${pr.title}> by ${requester}`,
    log: `👀 Queued: Review requested on PR #${pr.number} by ${requester}`,
  });
}

/**
 * Notify on comments
 */
async function notifyOnComment(comment, pr) {
  const commentId = `${pr.number}-comment-${comment.id}`;

  if (STATE.seenComments.has(commentId)) {
    return;
  }

  // Skip bot comments
  if (comment.user.type === 'Bot') {
    STATE.seenComments.add(commentId);
    return;
  }

  // Skip comments authored by the user themselves
  if (comment.user.login === CONFIG.GITHUB_USERNAME) {
    STATE.seenComments.add(commentId);
    return;
  }

  STATE.seenComments.add(commentId);

  const snippet = comment.body.replace(/\s+/g, ' ').trim();
  const truncatedBody = snippet.length > 100 ? snippet.substring(0, 100) + '…' : snippet;

  PENDING.push({
    category: 'comment',
    repo: pr.repository_url.split('/').slice(-1)[0],
    line: `<${pr.html_url}|#${pr.number} - ${pr.title}> by ${comment.user.login}: _${truncatedBody}_ (<${comment.html_url}|view>)`,
    log: `💬 Queued: Comment on PR #${pr.number} by ${comment.user.login}`,
  });
}

/**
 * Format PR data into Slack summary message
 */
function formatSummaryMessage(prs) {
  if (prs.length === 0) {
    return {
      text: '✅ No open PRs assigned to you!',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '✅ *All clear!* No open PRs assigned to you right now.',
          },
        },
      ],
    };
  }

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📋 Your Open PRs (${prs.length})`,
      },
    },
  ];

  // Group PRs by repository
  const prsByRepo = {};
  prs.forEach((pr) => {
    const repo = pr.repository_url.split('/').slice(-1)[0];
    if (!prsByRepo[repo]) {
      prsByRepo[repo] = [];
    }
    prsByRepo[repo].push(pr);
  });

  // One compact section per repo: repo header + bulleted PR list
  Object.entries(prsByRepo).forEach(([repo, repoPRs]) => {
    const lines = [`*${repo}*`];
    repoPRs.forEach((pr) => {
      const updated = new Date(pr.updated_at).toLocaleDateString();
      lines.push(`• <${pr.html_url}|#${pr.number} - ${pr.title}> _(updated ${updated})_`);
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    });
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Last checked: ${new Date().toLocaleString()}`,
      },
    ],
  });

  return {
    text: `Your Open PRs (${prs.length})`,
    blocks: blocks,
  };
}

/**
 * Run real-time notifications (check for approvals, comments, changes)
 */
async function runRealtime() {
  console.log(`\n[REALTIME] ${new Date().toLocaleString()}`);
  console.log('🔍 Checking for approvals, comments, and change requests...');

  PENDING = [];
  const prs = await getRelevantPRs();

  if (prs.length === 0) {
    console.log('   No open PRs found');
    return;
  }

  for (const pr of prs) {
    const { owner, repo } = parseRepoInfo(pr.repository_url);

    const reviews = await getPRReviews(pr.number, owner, repo);
    for (const review of reviews) {
      await notifyOnApproval(review, pr);
      await notifyOnChangeRequest(review, pr);
    }

    const comments = await getPRComments(pr.number, owner, repo);
    for (const comment of comments) {
      await notifyOnComment(comment, pr);
    }

    const timeline = await getPRTimeline(pr.number, owner, repo);
    for (const event of timeline) {
      await notifyOnReviewRequest(event, pr);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await flushPending();
  saveState();
}

/**
 * Send all queued notifications as a single Slack message,
 * grouped by category and then by repository.
 */
async function flushPending() {
  if (PENDING.length === 0) {
    console.log('✅ Check complete. No new notifications.');
    return;
  }

  const total = PENDING.length;
  const CATEGORY_ORDER = ['review_requested', 'changes_requested', 'approved', 'comment'];
  const CATEGORY_LABELS = {
    review_requested: '👀 Reviews Requested',
    changes_requested: '🔄 Changes Requested',
    approved: '✅ Approvals',
    comment: '💬 Comments',
  };

  // Group: category -> repo -> [lines]
  const grouped = {};
  for (const item of PENDING) {
    if (!grouped[item.category]) grouped[item.category] = {};
    if (!grouped[item.category][item.repo]) grouped[item.category][item.repo] = [];
    grouped[item.category][item.repo].push(item.line);
  }

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📬 PR Activity (${total} update${total === 1 ? '' : 's'})`,
      },
    },
  ];

  for (const cat of CATEGORY_ORDER) {
    const repos = grouped[cat];
    if (!repos) continue;
    const count = Object.values(repos).reduce((acc, arr) => acc + arr.length, 0);
    const sections = [`*${CATEGORY_LABELS[cat]} (${count})*`];
    for (const [repo, lines] of Object.entries(repos)) {
      sections.push(`*${repo}*\n` + lines.map((l) => `• ${l}`).join('\n'));
    }
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: sections.join('\n') },
    });
  }

  try {
    await sendSlackMessage({
      text: `PR Activity (${total} update${total === 1 ? '' : 's'})`,
      blocks,
    });
    PENDING.forEach((item) => console.log(item.log));
    console.log(`✅ Check complete. Sent ${total} notification(s) in a single message.`);
  } catch (error) {
    console.error('❌ Failed to send batched notification:', error.message);
  }
}

/**
 * Run summary (send daily digest)
 */
async function runSummary() {
  console.log(`\n[SUMMARY] ${new Date().toLocaleString()}`);
  console.log('📋 Fetching all open PRs...');

  try {
    const prs = await getRelevantPRs();
    console.log(`   Found ${prs.length} open PR(s)`);

    const message = formatSummaryMessage(prs);
    console.log('   Sending to Slack...');
    await sendSlackMessage(message);

    console.log('✅ Summary sent!');
  } catch (error) {
    console.error('❌ Error sending summary:', error.message);
    process.exit(1);
  }
}

/**
 * Main
 */
async function main() {
  validateConfig();
  loadState();

  if (MODE === 'summary') {
    await runSummary();
  } else if (MODE === 'realtime') {
    await runRealtime();
  } else {
    console.error(`❌ Unknown mode: ${MODE}`);
    console.error('Usage: node github-pr-monitor.js [summary|realtime]');
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});