// DayZ deploy webhook service — run on Railway.
//
// Flow: GitHub push -> webhook hits this server -> verify signature ->
// download the repo as a tarball via GitHub's API (no git binary needed) ->
// upload/delete only the files that changed in this push over SFTP ->
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
const tar = require('tar');
const { pipeline } = require('stream/promises');
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
  const changes = collectChangedFiles(req.body.commits); // [{ file, tag }]

  try {
    await withTimeout(deployAll(changes.map(c => c.file)), 90000, 'Overall deploy timed out after 90s');
    await notifyDiscord(true, sha, actor, null, changes);
    console.log('Deploy succeeded for', sha);
  } catch (err) {
    console.error('Deploy failed:', err);
    await notifyDiscord(false, sha, actor, err.message, changes);
  }
});

async function deployAll(changedFilePaths) {
  await syncRepo();
  await uploadChangedFiles(changedFilePaths);
}

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

  return [...files.entries()].map(([file, types]) => ({
    file,
    tag: [...types].join('+'), // e.g. "added", "modified+removed"
  }));
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

function parseOwnerRepo(url) {
  // Accepts https://github.com/owner/repo.git or https://github.com/owner/repo
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+?)(\.git)?\/?$/);
  if (!match) throw new Error(`Could not parse owner/repo from REPO_URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

async function syncRepo() {
  const { owner, repo } = parseOwnerRepo(process.env.REPO_URL);
  const token = process.env.GITHUB_TOKEN;

  console.log('Downloading tarball for', `${owner}/${repo}`, 'branch', BRANCH);

  // Start from a clean directory each time — simplest way to guarantee
  // an exact match with the remote, no leftover/renamed files.
  await fs.promises.rm(REPO_DIR, { recursive: true, force: true });
  await fs.promises.mkdir(REPO_DIR, { recursive: true });

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${BRANCH}`;
  const headers = { 'User-Agent': 'dayz-deploy-service' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(apiUrl, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`GitHub tarball download failed: ${response.status} ${response.statusText}`);
  }

  // GitHub wraps the tarball contents in one top-level folder
  // (owner-repo-<sha>/) — strip: 1 drops that so files land directly
  // in REPO_DIR, matching the mpmissions/ and profiles/ layout.
  await pipeline(response.body, tar.extract({ cwd: REPO_DIR, strip: 1 }));
  console.log('Tarball extracted to', REPO_DIR);
}

// DayZ writes live logs into profiles/ while running (.ADM, .RPT, .log).
// These get locked by the running server process — never try to overwrite
// them, and they shouldn't be tracked in the repo in the first place.
const EXCLUDED_EXTENSIONS = ['.adm', '.rpt', '.log'];

function isExcludedFile(itemPath) {
  return EXCLUDED_EXTENSIONS.includes(path.extname(itemPath).toLowerCase());
}

async function uploadChangedFiles(changedFilePaths) {
  const sftp = new SftpClient();
  console.log('Connecting to SFTP:', process.env.SFTP_HOST, process.env.SFTP_PORT);

  await sftp.connect({
    host: process.env.SFTP_HOST,
    port: Number(process.env.SFTP_PORT || 22),
    username: process.env.SFTP_USERNAME,
    password: process.env.SFTP_PASSWORD,
    readyTimeout: 15000, // fail loudly after 15s instead of hanging forever
  });
  console.log('SFTP connected');

  try {
    for (const relPath of changedFilePaths) {
      await syncOneFile(sftp, relPath);
    }
  } finally {
    await sftp.end();
    console.log('SFTP connection closed');
  }
}

// Maps a repo-relative path (e.g. "profiles/foo.txt") to its remote
// counterpart under REMOTE_PROFILES_PATH / REMOTE_MISSION_PATH, uploads it
// if it still exists locally (added/modified), or deletes it remotely if it
// doesn't (removed in this push). Anything outside mpmissions/ or profiles/,
// or matching an excluded extension, is skipped.
async function syncOneFile(sftp, relPath) {
  if (isExcludedFile(relPath)) {
    console.log('Skipping runtime file:', relPath);
    return;
  }

  let remoteRoot, subPath;
  if (relPath.startsWith('mpmissions/')) {
    remoteRoot = process.env.REMOTE_MISSION_PATH;
    subPath = relPath.slice('mpmissions/'.length);
  } else if (relPath.startsWith('profiles/')) {
    remoteRoot = process.env.REMOTE_PROFILES_PATH;
    subPath = relPath.slice('profiles/'.length);
  } else {
    console.log('Skipping file outside synced folders:', relPath);
    return;
  }

  const localFull = path.join(REPO_DIR, relPath);
  const remoteFull = path.posix.join(remoteRoot, subPath);

  if (fs.existsSync(localFull)) {
    const remoteDir = path.posix.dirname(remoteFull);
    await sftp.mkdir(remoteDir, true); // recursive, no-ops if it already exists
    await sftp.put(localFull, remoteFull);
    console.log('Uploaded:', relPath, '->', remoteFull);
  } else {
    try {
      await sftp.delete(remoteFull);
      console.log('Deleted on server (removed from repo):', remoteFull);
    } catch (err) {
      console.log('Could not delete on server (may not exist there):', remoteFull, '-', err.message);
    }
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
function formatChangedFiles(changes) {
  if (!changes || changes.length === 0) return '';

  const MAX_LINES = 15;
  const lines = changes.map(c => `${c.tag}: ${c.file}`);
  const shown = lines.slice(0, MAX_LINES);
  const remaining = lines.length - shown.length;

  let block = '```\n' + shown.join('\n') + '\n```';
  if (remaining > 0) block += `_...and ${remaining} more file(s)_`;

  return block;
}

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
