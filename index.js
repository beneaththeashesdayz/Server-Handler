// DayZ deploy webhook service — run on Railway.
//
// Flow: GitHub push -> webhook hits this server -> verify signature ->
// git pull the repo -> upload mpmissions/ and profiles/ over SFTP ->
// notify Discord.
//
// Required environment variables (set these in Railway > Variables):
//   GITHUB_WEBHOOK_SECRET   - a secret string, must match the one you set
//                             in GitHub's webhook config
//   REPO_URL                - e.g. https://github.com/you/your-repo.git
//   REPO_BRANCH             - defaults to "main"
//   GITHUB_TOKEN            - optional; only needed if REPO_URL points at a
//                             private repo. A GitHub personal access token
//                             with "repo" (read) scope.
//   SFTP_HOST               - from GTX game panel sFTP Info
//   SFTP_PORT               - from GTX game panel sFTP Info
//   SFTP_USERNAME           - GTX control panel username
//   SFTP_PASSWORD           - GTX control panel password
//   REMOTE_MISSION_PATH     - e.g. /mpmissions/dayzOffline.chernarusplus
//   REMOTE_PROFILES_PATH    - e.g. /profiles
//   DISCORD_WEBHOOK_URL     - optional, skip notifications if unset

const express = require('express');
const crypto = require('crypto');
const simpleGit = require('simple-git');
const SftpClient = require('ssh2-sftp-client');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const REPO_DIR = '/tmp/repo';
const BRANCH = process.env.REPO_BRANCH || 'main';

// Keep the raw body around so we can verify the GitHub signature.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.get('/', (req, res) => res.send('dayz-deploy-service: ok'));

app.post('/webhook', async (req, res) => {
  console.log('Webhook hit. ref:', req.body && req.body.ref, '| has signature header:', !!req.headers['x-hub-signature-256']);

  if (!verifySignature(req)) {
    console.log('Rejected: signature verification failed');
    return res.status(401).send('bad signature');
  }

  const ref = req.body.ref; // e.g. "refs/heads/main"
  if (ref !== `refs/heads/${BRANCH}`) {
    console.log(`Ignored: push was to ${ref}, watching refs/heads/${BRANCH}`);
    return res.status(200).send(`ignored (push to ${ref}, not ${BRANCH})`);
  }

  // Respond immediately so GitHub doesn't time out; do the work after.
  res.status(202).send('deploy started');

  const sha = req.body.after;
  const actor = req.body.pusher ? req.body.pusher.name : 'unknown';
  const changedFiles = collectChangedFiles(req.body.commits);

  try {
    await syncRepo();
    await uploadToServer();
    await notifyDiscord(true, sha, actor, null, changedFiles);
    console.log('Deploy succeeded for', sha);
  } catch (err) {
    console.error('Deploy failed:', err);
    await notifyDiscord(false, sha, actor, err.message, changedFiles);
  }
});

// GitHub's push payload lists added/removed/modified files per-commit.
// A push can contain several commits, so this merges them into one
// deduplicated list, tagged with what happened to each file.
function collectChangedFiles(commits) {
  const files = new Map(); // path -> Set of change types

  for (const commit of commits || []) {
    for (const f of commit.added || [])    addChange(files, f, 'added');
    for (const f of commit.modified || []) addChange(files, f, 'modified');
    for (const f of commit.removed || [])  addChange(files, f, 'removed');
  }

  return [...files.entries()].map(([file, types]) => {
    const tag = [...types].join('+'); // e.g. "added", "modified+removed"
    return `${tag}: ${file}`;
  });
}

function addChange(map, file, type) {
  if (!map.has(file)) map.set(file, new Set());
  map.get(file).add(type);
}

function verifySignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const signature = req.headers['x-hub-signature-256'];
  if (!secret || !signature || !req.rawBody) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch etc.
  }
}

function authenticatedRepoUrl() {
  const url = process.env.REPO_URL;
  const token = process.env.GITHUB_TOKEN;
  if (!token) return url; // public repo, no token needed

  // Turns https://github.com/user/repo.git into
  // https://<token>@github.com/user/repo.git
  return url.replace('https://', `https://${token}@`);
}

async function syncRepo() {
  const url = authenticatedRepoUrl();
  if (!fs.existsSync(REPO_DIR)) {
    await simpleGit().clone(url, REPO_DIR, ['--branch', BRANCH, '--depth', '1']);
  } else {
    const git = simpleGit(REPO_DIR);
    // Update the remote URL each time in case the token was rotated.
    await git.remote(['set-url', 'origin', url]);
    await git.fetch();
    await git.reset(['--hard', `origin/${BRANCH}`]);
  }
}

async function uploadToServer() {
  const sftp = new SftpClient();
  await sftp.connect({
    host: process.env.SFTP_HOST,
    port: Number(process.env.SFTP_PORT || 22),
    username: process.env.SFTP_USERNAME,
    password: process.env.SFTP_PASSWORD,
  });

  try {
    const missionLocal = path.join(REPO_DIR, 'mpmissions');
    const profilesLocal = path.join(REPO_DIR, 'profiles');

    if (fs.existsSync(missionLocal)) {
      await sftp.uploadDir(missionLocal, process.env.REMOTE_MISSION_PATH);
    }
    if (fs.existsSync(profilesLocal)) {
      await sftp.uploadDir(profilesLocal, process.env.REMOTE_PROFILES_PATH);
    }
  } finally {
    await sftp.end();
  }
}

async function notifyDiscord(success, sha, actor, errorMessage, changedFiles) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const shortSha = sha ? sha.substring(0, 7) : 'unknown';
  const header = success
    ? `✅ DayZ deploy succeeded — commit \`${shortSha}\` by ${actor}. Restart the server from the GTX panel to apply.`
    : `❌ DayZ deploy failed — commit \`${shortSha}\` by ${actor}. Error: ${errorMessage}`;

  const content = header + '\n' + formatChangedFiles(changedFiles);

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

// Discord messages cap at 2000 chars, so long file lists get truncated
// with a count of how many more there were.
function formatChangedFiles(changedFiles) {
  if (!changedFiles || changedFiles.length === 0) return '';

  const MAX_LINES = 15;
  const shown = changedFiles.slice(0, MAX_LINES);
  const remaining = changedFiles.length - shown.length;

  let block = '```\n' + shown.join('\n') + '\n```';
  if (remaining > 0) block += `_...and ${remaining} more file(s)_`;

  return block;
}

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
