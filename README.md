# DayZ Deploy Service (Railway)

Listens for a GitHub push webhook, pulls your repo, and uploads the
`mpmissions/` and `profiles/` folders to your GTX DayZ server over SFTP.
Sends a Discord message when it's done.

## 1. Push this folder to a GitHub repo

This can be the same repo as your mission files, or a separate small repo
just for this service — either works, since `REPO_URL` below points at
wherever your actual mission/profiles files live.

## 2. Deploy to Railway

1. Go to https://railway.com and create a new project.
2. Choose "Deploy from GitHub repo" and select this repo.
3. Railway will detect the Node app automatically (via `package.json`) and
   build it.

## 3. Set environment variables

In Railway: your project → Variables tab → add each of these (see
`.env.example` for the full list):

- `GITHUB_WEBHOOK_SECRET` — make up a random string, you'll reuse it in step 4
- `REPO_URL` — the repo with your `mpmissions/` and `profiles/` folders
- `REPO_BRANCH` — usually `main`
- `SFTP_HOST`, `SFTP_PORT`, `SFTP_USERNAME`, `SFTP_PASSWORD` — from your GTX
  game panel's sFTP Info
- `REMOTE_MISSION_PATH` — e.g. `/mpmissions/dayzOffline.chernarusplus`
  (adjust for your map)
- `REMOTE_PROFILES_PATH` — e.g. `/profiles`
- `DISCORD_WEBHOOK_URL` — optional, from Discord channel Settings →
  Integrations → Webhooks

## 4. Get your Railway public URL

Railway → Settings → Networking → "Generate Domain". You'll get something
like `https://dayz-deploy-service-production.up.railway.app`.

## 5. Add the webhook in GitHub

In the repo with your mission/profiles files:
Settings → Webhooks → Add webhook

- Payload URL: `https://<your-railway-domain>/webhook`
- Content type: `application/json`
- Secret: the same string you set as `GITHUB_WEBHOOK_SECRET` in Railway
- Events: "Just the push event"

## 6. Test it

Push a small change to `mpmissions/` or `profiles/` on the `main` branch.
Check the Railway logs (Deployments → View Logs) to see it pull and upload.
You should get a Discord message if you set that up.

## Notes

- The server restart is still manual — DayZ won't pick up new files while
  running. Restart from the GTX game panel after a deploy, or wire up RCON
  separately if you want that automated too.
- Railway's filesystem is ephemeral between deploys of *this* service, but
  since the repo is re-cloned/pulled on every webhook call, that's fine —
  it always works from a fresh pull.
- GTX blocks `.DLL/.EXE/.BAT` uploads by default; open a support ticket
  with them if you need those unblocked.
