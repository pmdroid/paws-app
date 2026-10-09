# Paws on Railway

Hosted mode runs the same Bun process as a laptop, on Railway, with org API keys. It does not use a personal Claude or Codex login, and it does not start ngrok. Local mode is unchanged: `bun run paws` still listens on `127.0.0.1:8787` and keeps using `~/.paws`.

## What the image contains

The `Dockerfile` is based on `oven/bun:1.4.2` and starts `bun run paws` as the non-root `bun` user (uid 1000). It installs:

| Tool               | Pin                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------- |
| git                | Debian package in the image                                                              |
| `closeout`         | Rust reference runner `0.1.0` at git revision `baac33e8715aac9d646796035ecc9ba7aaee02ef` |
| `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp@0.88.0`                                           |
| `codex-acp`        | `@agentclientprotocol/codex-acp@2.1.1`                                                   |
| Claude Code CLI    | `@anthropic-ai/claude-code@2.1.296`                                                      |
| Codex CLI          | `@openai/codex@0.162.1`                                                                  |
| Node.js            | `22.23.3` (the CLIs ship a node shebang; Bun still runs Paws)                            |

`railway.toml` selects the Dockerfile builder, checks `GET /health`, and restarts on failure (10 retries). Create the volume in the service settings. Config-as-code cannot attach it. Mount path: `/data`.

## Deploy

1. Create a Railway project and a service from this repository. Railway finds `Dockerfile` and `railway.toml`.
2. Add a volume. Set the mount path to `/data`.
3. Generate a public domain for the service. Railway sets `RAILWAY_PUBLIC_DOMAIN` and `PORT`.
4. Set the variables in the next section. Do not commit them.
5. Deploy. The first boot creates the SQLite database, worktrees, and runs under `/data`.
6. Confirm `GET https://<domain>/health` returns `{"ok":true,"service":"paws"}`.
7. Point Linear at `https://<domain>/webhooks/linear` and the GitHub App at `https://<domain>/webhooks/github`.
8. Open `https://<domain>/` (it redirects to `/status`). The browser asks for the dashboard token. `/api/status` returns the same JSON to `Authorization: Bearer <token>` or HTTP Basic (any username, password = token).

`/health` and the webhook routes stay unauthenticated. Webhooks still require their own signatures. `/status` and `/api/status` require `PAWS_DASHBOARD_TOKEN` in hosted mode. If that token is missing, those routes fail closed.

The volume must be writable by uid 1000. The image creates `/data` owned by `bun`, and a fresh Railway volume is writable by the container user. The filesystem outside the volume is ephemeral.

## Environment

The image sets `PAWS_MODE=hosted` and `PAWS_HOME=/data`. Railway injects `PORT`, `RAILWAY_PUBLIC_DOMAIN`, and `RAILWAY_VOLUME_MOUNT_PATH`. An unset `PAWS_MODE` still turns hosted mode on when `RAILWAY_ENVIRONMENT` or `RAILWAY_PROJECT_ID` is present. `PAWS_MODE=local` forces local mode.

Hosted mode binds `0.0.0.0` and reads `PORT` before `PAWS_PORT`. The public URL is `https://$RAILWAY_PUBLIC_DOMAIN` unless `PAWS_PUBLIC_URL` is set. ngrok is not started. Laptop keep-awake (`caffeinate` / `systemd-inhibit`) and sleep detection are off. Awake-time caps still accrue while a run is active.

Secrets come from the environment. Paws does not require a key file under `~/.paws/secrets`. A refreshed Linear token is written on the volume at `$PAWS_HOME/secrets/linear-oauth.json` so a restart can keep using it. The GitHub private key stays in the environment and is not written to disk.

| Variable                      | Required                             | Purpose                                           |
| ----------------------------- | ------------------------------------ | ------------------------------------------------- |
| `PAWS_MODE`                   | set by the image                     | `hosted`                                          |
| `PAWS_HOME`                   | yes                                  | Volume mount. `/data`                             |
| `PORT`                        | set by Railway                       | Listen port                                       |
| `PAWS_HOST`                   | no                                   | Defaults to `0.0.0.0`. Do not set `127.0.0.1`     |
| `RAILWAY_PUBLIC_DOMAIN`       | yes, unless `PAWS_PUBLIC_URL` is set | Public hostname, no scheme                        |
| `PAWS_PUBLIC_URL`             | no                                   | Overrides the domain. Must be `https`             |
| `LINEAR_CLIENT_ID`            | yes                                  | Linear OAuth app                                  |
| `LINEAR_CLIENT_SECRET`        | yes                                  | Linear OAuth app                                  |
| `LINEAR_WEBHOOK_SECRET`       | yes                                  | HMAC for `Linear-Signature`                       |
| `LINEAR_ACCESS_TOKEN`         | one of these                         | App access token                                  |
| `LINEAR_REFRESH_TOKEN`        | one of these                         | Refresh token, if the access token expires        |
| `GITHUB_APP_ID`               | yes                                  | Numeric GitHub App id                             |
| `GITHUB_APP_INSTALLATION_ID`  | yes                                  | Numeric installation id                           |
| `GITHUB_APP_PRIVATE_KEY`      | yes                                  | PEM. Real newlines or `\n` escapes both work      |
| `GITHUB_WEBHOOK_SECRET`       | yes                                  | HMAC for `X-Hub-Signature-256`                    |
| `ANTHROPIC_API_KEY`           | one Anthropic source                 | Org key for Claude Code / `claude-agent-acp`      |
| `ANTHROPIC_AUTH_TOKEN`        | one Anthropic source                 | Alternate Claude credential                       |
| `ANTHROPIC_BASE_URL`          | one Anthropic source                 | Model proxy for Claude                            |
| `OPENAI_API_KEY`              | one OpenAI source                    | Org key for Codex / `codex-acp`                   |
| `OPENAI_BASE_URL`             | one OpenAI source                    | Model proxy for Codex                             |
| `PAWS_MODEL_PROXY_URL`        | counts for both                      | Copied to both base URLs when those are unset     |
| `PAWS_DASHBOARD_TOKEN`        | yes                                  | At least 16 characters. Bearer or Basic password  |
| `GITHUB_APP_PRIVATE_KEY_PATH` | no                                   | Local mode only. Ignored as the hosted key source |
| `NGROK_AUTHTOKEN`             | no                                   | Not used in hosted mode                           |
| `PAWS_CLAUDE_ACP`             | no                                   | Override the `claude-agent-acp` command           |
| `PAWS_CODEX_ACP`              | no                                   | Override the `codex-acp` command                  |
| `CLOSEOUT_BIN`                | no                                   | Override the `closeout` binary on `PATH`          |

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are passed into the agent process in hosted mode so the CLIs can authenticate. They are still stripped in local mode, which keeps using the developer's existing login. GitHub tokens, the GitHub App private key, Linear tokens, the webhook secrets, and `PAWS_DASHBOARD_TOKEN` are never copied into the agent environment. The ACP permission guard still denies reads under the Paws home (including `/data/secrets`), credential paths, and `git push`.

## Check the environment

From a shell that has the hosted variables exported:

```sh
bun run paws doctor
```

`paws doctor · hosted` prints one line per check and exits 0 when the process can boot on Railway. It exits 1 when a required variable is missing. It does not print secret values. In local mode the same command exits 0 and tells you to set `PAWS_MODE=hosted` to validate Railway.

On Railway, after the variables are saved:

```sh
railway run -- bun run paws doctor
```

Use that before relying on a deploy. A failing doctor report is the list of variables still missing.
