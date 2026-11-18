# Slack

A Paws workspace admin connects one Slack workspace to a Paws workspace. Connecting installs the Paws app in Slack. It does not give Slack users Paws membership, repository access or permission to start work, and it does not let Paws read anyone's private messages except the messages people send to the Paws app itself.

Paws does not yet answer Slack threads or app messages. A connection today records the installation, its identity and its scopes so those conversations can start on it later.

## Create the Slack app

1. Sign in to the dashboard as a workspace admin and read `GET /api/workspaces/slack`. Its `manifest` field is the app manifest for this Paws instance, with the redirect URL `https://<paws>/oauth/slack/callback` and the events URL `https://<paws>/webhooks/slack`.
2. On [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App › From an app manifest** and paste it. Turn on **Manage Distribution** if the app will be installed into more than one Slack workspace.
3. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` on the Paws server, or save them with `bun run paws install secrets`. Set `SLACK_APP_ID` too so Paws refuses an installation of any other app.

Paws needs `PAWS_PUBLIC_URL` (or a public dashboard) on HTTPS so Slack can reach the callback and the events URL.

## Scopes and capabilities

The manifest asks only for bot scopes:

| Capability      | Scopes                                                                 | Events                                                         |
| --------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| Channel threads | `app_mentions:read`, `channels:history`, `channels:read`, `chat:write` | `app_mention`, `message.channels`                              |
| App messages    | `im:history`, `im:write`, `chat:write`                                 | `message.im`                                                   |
| Agent status    | `assistant:write`                                                      | `assistant_thread_started`, `assistant_thread_context_changed` |
| Member checks   | `users:read`, `users:read.email`                                       |                                                                |

Paws also listens for `app_uninstalled` and `tokens_revoked`. The connection status lists the granted and missing scopes per capability, and names the scopes a reconnect would add. Slack Code is not offered yet; the status says so rather than reporting it as set up.

## Connect, reconnect and disconnect

A workspace admin starts with `POST /api/workspaces/slack/connect` and an `intent` of `install`, `reconnect` or `replace`. Started from a Slack channel or app message, it also takes `returnTo: { teamId, channelId }`, and Paws sends the admin back there when the installation completes in that Slack workspace. Otherwise Paws returns to **Workspace › Integrations**.

- The authorization link is valid for ten minutes, once, for the admin, session and Paws workspace that asked for it. Paws checks again on the callback that the person is still an active admin.
- Slack decides whether the installer may install. In a workspace that requires app approval, a Slack admin must approve the app first; a Paws admin role does not bypass that.
- Paws checks the returned team, app and bot with Slack before it saves anything. A Slack workspace connects to only one Paws workspace. Switching a Paws workspace to a different Slack workspace needs `replace`; `reconnect` to another team is refused and leaves the existing connection as it was. A denied or failed authorization also leaves it as it was.
- `DELETE /api/workspaces/slack` disconnects: Paws deletes the stored token and asks Slack to revoke it. Uninstalling the app in Slack or revoking its token does the same for that installation only. Every change is in the workspace audit with the admin and the Slack team.

## From paws login slack

An installation made with `paws login slack` stays usable. A workspace admin moves it into their Paws workspace with `POST /api/workspaces/slack/adopt`. Paws checks the token with Slack, keeps the same scopes, records the connection as `cli` and removes the unscoped copy. Reconnect afterwards to grant the scopes the CLI installation lacks.
