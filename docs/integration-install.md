# Install the workspace integrations

Allow 15 minutes with a sandbox Linear workspace, a GitHub organization and a repository already created. Use a workspace admin account and a GitHub account that can install Apps on that repository. Have Bun 1.4.2+, Git, an HTTPS origin and certificate for Paws, and a Linux runner available.

## 1. Register the apps, about five minutes

In [Linear's application settings](https://linear.app/settings/api/applications), create an OAuth application. Register `https://YOUR-PAWS-HOST/auth/linear/callback` and `https://YOUR-PAWS-HOST/auth/linear/install/callback`. Enable agent delegation and mentions. Select **Agent session events**, **Issues**, **Inbox notifications**, and **Permission changes** for its webhooks. Set the webhook URL to `https://YOUR-PAWS-HOST/webhooks/linear` and retain its signing secret. Paws requests `actor=app`, `read,write,app:assignable,app:mentionable`, state and PKCE S256.

Create a [GitHub App](https://github.com/settings/apps/new) with callback `https://YOUR-PAWS-HOST/auth/github-app/callback`. Grant **Contents**, **Pull requests**, **Checks**, and **Issues** read and write, and **Commit statuses** and **Merge queues** read-only. Metadata read access is automatic. Enable its webhook at `https://YOUR-PAWS-HOST/webhooks/github`, with content type `application/json` and the secret from `GITHUB_WEBHOOK_SECRET`. Subscribe to **Check runs**, **Check suites**, **Statuses**, **Pull requests**, **Pull request reviews**, **Merge groups**, **Pushes**, **Installations** and **Installation repositories**. Generate a private key and client secret. Install the App on **Only select repositories**, choosing the sandbox repository. Details are in [GitHub sign-in](github-login.md).

Set these environment variables on the Paws server using the app settings. Keep the private key outside the checkout.

| Variable                      | Value                                      |
| ----------------------------- | ------------------------------------------ |
| `GITHUB_APP_ID`               | GitHub App ID                              |
| `PAWS_GITHUB_CLIENT_ID`       | GitHub App client ID                       |
| `PAWS_GITHUB_CLIENT_SECRET`   | GitHub App client secret                   |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to the downloaded private key         |
| `GITHUB_WEBHOOK_SECRET`       | A webhook secret chosen for the GitHub App |
| `PAWS_GITHUB_REPOSITORY`      | `organization/sandbox-repository`          |
| `LINEAR_CLIENT_ID`            | Linear OAuth client ID                     |
| `LINEAR_CLIENT_SECRET`        | Linear OAuth client secret                 |
| `LINEAR_WEBHOOK_SECRET`       | Linear webhook signing secret              |

## 2. Connect GitHub and Linear

Configure the [HTTPS workspace access](workspace-access.md) environment and callbacks, then start Paws:

```sh
bun install
bun run build:status
bun run paws --no-tunnel
```

Open the HTTPS dashboard. Sign in as a Linear workspace admin and authorize Paws in the same workspace. In Integrations, connect GitHub, choose the sandbox repository and map it to the sandbox Linear team. Commit the repository's Closeout policy before delegating work. Pair a runner and connect its coding-agent accounts through Runners.

## 3. Connect Slack, about three minutes

Create a [Slack app](https://api.slack.com/apps). Add the redirect URL `https://YOUR-PAWS-HOST/oauth/slack/callback` under **OAuth & Permissions**. Configure these bot scopes: `chat:write`, `im:write`, `users:read`, `users:read.email`, and `channels:read`.

Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` from the app settings, then run:

```sh
bun run paws login slack
```

Open the printed authorization URL and approve the sandbox workspace. The temporary listener uses port `8787`, reached through the HTTPS tunnel. It exits after printing **Slack connected**. Run this command while the Paws server is stopped.

## 4. Start and check, about two minutes

```sh
bun run paws --no-tunnel
```

Open your configured HTTPS dashboard. Confirm the configured repository and connected GitHub account. In Linear, mention or delegate a sandbox issue to Paws and confirm its first activity appears. Check the Linear application's webhook delivery status. In the GitHub App settings, use **Advanced > Redeliver** on its ping and confirm HTTP 200.

In Slack's **Event Subscriptions**, set the Request URL to `https://YOUR-PAWS-HOST/webhooks/slack`. Confirm Slack reports **Verified**, which checks the signed challenge through the running server.

Stop and restart Paws. The saved integrations should still load, and the next Linear poll should succeed. Repository operations use fresh GitHub installation tokens restricted to the selected repository and branches named `paws/*`.

## Credential storage and recovery

File-backed credentials use AES-256-GCM envelope encryption, with a separate data key for each credential. The key-encryption key is `~/.paws/secrets/.envelope-key`, outside `paws.db`. Keep that key in a separate protected backup from database backups. Credential files use mode `0600`; the secrets directory uses `0700`. GitHub sign-in can also use the OS keychain. Existing plaintext credential files migrate when Paws reads them.

Linear refresh jobs contain hashes and job metadata. Tokens remain in encrypted credential files. A restart reclaims the refresh lease and replays a lost token response within [Linear's 30-minute grace period](https://linear.app/developers/oauth-2-0-authentication). A successful refresh saves the rotated token before completing the job. Slack installations with token rotation use the same job mechanism when an access token is needed.

To reconnect an integration, complete its authorization again. Restore encrypted credentials together with their envelope key when restoring from backup.

## Repeat the automated checks

```sh
bun test test/credentials.test.ts test/credential-refresh.test.ts test/linear-callback.test.ts test/auth-app.test.ts test/slack-install.test.ts
bun --no-env-file scripts/verify-local.ts check
```

The installation tests inject provider responses and exercise real loopback callbacks, SQLite, encryption and a killed refresh process. They check that token values do not occur in database or credential bytes. The verification launcher isolates its home directory and uses scripted agents and local Git remotes.
