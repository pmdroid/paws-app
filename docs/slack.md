# Slack

A workspace admin connects one Slack workspace to a Paws workspace in **Workspace › Integrations**. This installs the Paws app in Slack. It gives Slack users no Paws membership, repository access or permission to start work, and Paws reads no private messages except those sent to the app. Paws does not answer in Slack yet.

## Create the Slack app

1. On [api.slack.com/apps](https://api.slack.com/apps), create an app. Under **OAuth & Permissions**, add the redirect URL `https://<paws>/oauth/slack/callback` and the bot scopes below. Turn on **Agents & AI Apps** and the **Messages Tab** in **App Home**.
2. Under **Event Subscriptions**, set the request URL `https://<paws>/webhooks/slack` and subscribe to the bot events `app_mention`, `message.channels`, `message.im` and `assistant_thread_started`. Turn on **Manage Distribution** to install it in more than one Slack workspace.
3. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` on the server, or save them with `bun run paws install secrets`. Set `SLACK_APP_ID` so Paws refuses any other app. Leave **Token Rotation** off: Paws refuses a rotating token. Slack must reach Paws over HTTPS.

## Scopes

Channel threads need `app_mentions:read`, `channels:history`, `channels:read` and `chat:write`. App messages need `im:history` and `im:write`. Agent status needs `assistant:write`. Member checks need `users:read` and `users:read.email`. The Integrations card shows each capability as ready, or names the scopes a reconnect adds. Slack Code is shown as not available yet.

## Connect, reconnect and disconnect

**Add to Slack** and **Reconnect** open Slack, which decides whether the admin may install. Where a Slack workspace requires app approval, a Slack admin approves the app first; a Paws admin role does not bypass that.

- The link works once, for ten minutes, for the admin, session and Paws workspace that started it. On return Paws checks that the person is still an admin before it saves the team, app and bot Slack returned.
- A Slack workspace connects to one Paws workspace. To switch to another Slack workspace, disconnect first. A denial, a failure, or a reconnect that returns another team or app leaves the connection as it was.
- When the setup starts from Slack with that Slack team and, optionally, a channel, Slack offers that team and a successful install returns the admin to the channel, or to the Paws app's messages when no channel was given. Otherwise the admin returns to Integrations.
- **Disconnect** deletes the token and revokes it with Slack. Each change is in the workspace audit.

## Use a `paws login slack` connection

`paws login slack` connects Slack to the server rather than to a Paws workspace. When such a connection exists and the Paws workspace has none, the Integrations card offers **Use the paws login slack connection**. It moves that token, with the scopes it already has, into the admin's Paws workspace and removes the server-wide copy, without opening Slack or asking for new permissions. Paws refuses when the workspace is already connected, the Slack workspace belongs to another Paws workspace, the token rotates, or it was issued to an app other than `SLACK_APP_ID`. The move is recorded in the workspace audit as `slack.adopted`.
