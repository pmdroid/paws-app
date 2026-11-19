# Slack

A workspace admin connects one Slack workspace to a Paws workspace in **Workspace › Integrations**. This installs the Paws app in Slack. It gives Slack users no Paws membership, repository access or permission to start work, and Paws reads no private messages except those sent to the app. Paws reads only the channel messages that mention it, in the one channel set up below.

## Create the Slack app

1. On [api.slack.com/apps](https://api.slack.com/apps), create an app. Under **OAuth & Permissions**, add the redirect URL `https://<paws>/oauth/slack/callback` and the bot scopes below. Turn on **Agents & AI Apps** and the **Messages Tab** in **App Home**.
2. Under **Event Subscriptions**, set the request URL `https://<paws>/webhooks/slack` and subscribe to the bot events `app_mention`, `message.channels`, `message.im`, `assistant_thread_started`, `app_uninstalled` and `tokens_revoked`. Turn on **Manage Distribution** to install it in more than one Slack workspace.
3. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` on the server, or enter them in the dashboard. Set `SLACK_APP_ID` so Paws refuses any other app. **Token Rotation** may be on or off; with it on, Paws refreshes a workspace's token when it is about to expire. Slack must reach Paws over HTTPS.

## Scopes

Channel threads need `app_mentions:read`, `channels:history`, `channels:read` and `chat:write`. App messages need `im:history` and `im:write`. Agent status needs `assistant:write`. Member checks need `users:read` and `users:read.email`. The Integrations card shows each capability as ready, or names the scopes a reconnect adds. Slack Code is shown as not available yet.

## Connect, reconnect and disconnect

**Add to Slack** and **Reconnect** open Slack, which decides whether the admin may install. Where a Slack workspace requires app approval, a Slack admin approves the app first; a Paws admin role does not bypass that.

- The link works once, for ten minutes, for the admin, session and Paws workspace that started it. On return Paws checks that the person is still an admin before it saves the team, app and bot Slack returned.
- A Slack workspace connects to one Paws workspace. To switch to another Slack workspace, disconnect first. A denial, a failure, or a reconnect that returns another team or app leaves the connection as it was.
- When the setup starts from Slack with that Slack team and, optionally, a channel, Slack offers that team and a successful install returns the admin to the channel, or to the Paws app's messages when no channel was given. Otherwise the admin returns to Integrations.
- **Disconnect** deletes the token and revokes it with Slack. Each change is in the workspace audit.
- When the app is uninstalled from Slack, or Slack revokes its bot token, Paws deletes that workspace's token and records `slack.revoked` in the audit. Other connected workspaces are unaffected, and an event from before the current installation is ignored. Add to Slack connects it again.
- If a rotating token can't be refreshed, the card asks the admin to reconnect.

## Answer in one channel

Paws answers explicit `@Paws` mentions in one internal channel per Paws workspace, in the mention's thread. It needs no repository and no Linear issue, and it starts no work: a thread is a conversation only. Direct messages, other channels and messages that don't mention Paws get no answer.

1. Invite Paws to the channel. The invitation alone changes nothing.
2. Someone mentions `@Paws` there. Paws replies with a message only they can see, with a link to `https://<paws>/oauth/slack/link` for them, in that channel.
3. They open that page, sign in to Paws, and get a code. They mention `@Paws link <code>` in the thread themselves. That links the Slack account that posted it to their Paws account. The first person to link must be a Paws workspace admin; their link also sets Paws up in that channel.

- A code works once, for ten minutes, only when posted by the Slack account and in the channel the link was for, in the same Slack installation. Posting it from Slack is what proves the Slack account; Paws links no one from a display name, an email address or who installed the app. Never give a code to someone else.
- Connecting Slack again (**Reconnect**, **Add to Slack** after a disconnect, or adopting a `paws login slack` connection) ends the channel setup, every link and every unused code, and Paws drops replies it hadn't posted yet; set up again as above.
- Before each answer and again before posting it, Paws checks that the person is still an active member, the installation is the same and the channel is still internal. A channel shared with another organization, archived or unreachable gets no answer. Setups and links are in the workspace audit as `slack.channel_admitted` and `slack.member_linked`.
- A turn sees only the asking member's own earlier questions in that thread and the replies Paws posted to them, at most 20. Other members' turns in the same thread, other threads and replies Paws never posted are left out.
- Slack redeliveries of the same mention produce one reply, and Paws posts each reply at most once. Before posting it records the attempt; it retries only when Slack clearly didn't take the message (a rate limit, waiting as long as Slack asks; a Slack server error; or a refused connection). When the outcome is unknown (the connection dropped or timed out after sending, the response was unreadable, Slack answered `fatal_error`, or Paws stopped mid-send), Paws never posts it again: it records the reply as unknown in its outbox and journal, and that reply may be missing. Any other Slack error drops the reply. A model turn interrupted before its reply was recorded runs again, but still produces one reply. Only replies Paws posted, with their Slack timestamp, count as context for later turns.
- Paws answers on the asking member's own paired runner, in its conversation lane, with the workspace's implementer agent. That lane is separate from implementation slots, so answers come even while every slot is busy. The runner must be at version 0.1.94 or newer, online and signed in to that agent. Without such a runner, Paws doesn't answer. While the lane is full, Paws retries the mention later. The runner sees only the thread's context, with no repository, files or tools.
- Paws answers only in public channels. In a private channel it posts nothing, not even setup messages.

## Use a `paws login slack` connection

`paws login slack` connects Slack to the server rather than to a Paws workspace. When such a connection exists and the Paws workspace has none, the Integrations card offers **Use the paws login slack connection**. It moves that token, with the scopes it already has, into the admin's Paws workspace and removes the server-wide copy, without opening Slack or asking for new permissions. Paws refuses when the workspace is already connected, the Slack workspace belongs to another Paws workspace, the token rotates, or it was issued to an app other than `SLACK_APP_ID`. The move is recorded in the workspace audit as `slack.adopted`.
