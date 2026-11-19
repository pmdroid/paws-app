# Slack

A workspace admin connects one Slack workspace to a Paws workspace in **Workspace › Integrations**. This installs the Paws app in Slack. It gives Slack users no Paws membership, repository access or permission to start work, and Paws reads no private messages except those sent to the app. Paws reads only the channel messages that mention it, in the one channel set up below.

## Create the Slack app

1. On [api.slack.com/apps](https://api.slack.com/apps), create an app. Under **OAuth & Permissions**, add the redirect URL `https://<paws>/oauth/slack/callback` and the bot scopes below. Turn on **Agents & AI Apps** and the **Messages Tab** in **App Home**.
2. Under **Event Subscriptions**, set the request URL `https://<paws>/webhooks/slack` and subscribe to the bot events `app_mention`, `message.channels`, `message.im`, `assistant_thread_started`, `app_uninstalled` and `tokens_revoked`. Under **Interactivity & Shortcuts**, turn on **Interactivity** and set the same request URL `https://<paws>/webhooks/slack`; Paws's **Stop** button needs it. Turn on **Manage Distribution** to install it in more than one Slack workspace.
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
4. Paws holds the question they asked before linking. When they link within ten minutes of asking it, Paws answers it once, in its original thread, after the same checks as any other mention. Only their latest question is held; an older one, or one asked more than ten minutes before the link, gets no answer. Linking starts no work and grants nothing beyond these answers.

- A code works once, for ten minutes, only when posted by the Slack account and in the channel the link was for, in the same Slack installation. Posting it from Slack is what proves the Slack account; Paws links no one from a display name, an email address or who installed the app. Never give a code to someone else. Any signed-in Paws session can open the link page, whether it began from the dashboard or from a Linear sign-in action.
- A Slack account links to one Paws account, and a Paws account to one Slack account, per Slack installation. A code that would move either link is used up and links nothing.
- Connecting Slack again (**Reconnect**, **Add to Slack** after a disconnect, or adopting a `paws login slack` connection) ends the channel setup, every link and every unused code, and Paws drops replies it hadn't posted yet; set up again as above.
- Before each answer and again before posting it, Paws checks that the person is still an active member, the installation is the same and the channel is still internal. A channel shared with another organization, archived or unreachable gets no answer. Setups and links are in the workspace audit as `slack.channel_admitted` and `slack.member_linked`.
- A turn sees only the asking member's own earlier questions in that thread and the replies Paws posted to them, at most 20. Other members' turns in the same thread, other threads and replies Paws never posted are left out; what carries across threads is the [channel memory](#channel-memory).
- Slack redeliveries of the same mention produce one reply, and Paws posts each reply at most once. Before posting it records the attempt; it retries only when Slack clearly didn't take the message (a rate limit, waiting as long as Slack asks; a Slack server error; or a refused connection). When the outcome is unknown (the connection dropped or timed out after sending, the response was unreadable, Slack answered `fatal_error`, or Paws stopped mid-send), Paws never posts it again: it records the reply as unknown in its outbox and journal, and that reply may be missing. Any other Slack error drops the reply. A model turn interrupted before its reply was recorded runs again, but still produces one reply. Only replies Paws posted, with their Slack timestamp, count as context for later turns.
- Paws answers on the asking member's own paired runner, in its conversation lane, with the workspace's implementer agent. That lane is separate from implementation slots, so answers come even while every slot is busy. The runner must be at version 0.1.94 or newer, online and signed in to that agent. Without such a runner, Paws doesn't answer. While the lane is full, Paws retries the mention later. The runner sees only the thread's context, with no repository, files or tools.
- Paws answers only in public channels. In a private channel it posts nothing, not even setup messages.

### Channel memory

Paws keeps a memory for the channel, so a new thread can build on what was decided in an earlier one. It holds only what linked members ask it to keep; Paws doesn't read or import channel history.

- `@Paws remember <text>` stores the text as a decision of the member who posted it, with the thread, message and time it came from. Paws replies, visible only to them, with the entry's id.
- `@Paws memory` lists up to ten current entries with their ids, visible only to the member who asked.
- `@Paws correct <id> <text>` replaces an entry; the old text is kept only as history and is no longer used. `@Paws forget <id>` removes an entry and every summary built from it, also after a restart. Only the entry's author or a Paws workspace admin can correct or forget it.
- Before each answer, Paws adds the entries most relevant to the question to the turn, within a bounded token budget, and folds older entries into a summary when the memory grows past it. The entries are background only: they never approve an action, a tool call, a run or a new issue.
- Memory belongs to the Paws workspace, the Slack installation and the channel's id, so renaming the channel keeps it, while another channel, another Paws workspace or a reconnected installation starts empty. Only linked, active members of the channel's current setup can add to it or have it used for their answers; unlinking, revoking or ending a membership stops that at once.
- When an entry an answer used is corrected or forgotten, or the member's access ends, before Paws posts the answer, Paws withholds it. If that happens before the answer is queued, the member sees a message, visible only to them, asking them to mention Paws again.
- Entries expire after 180 days. Memory needs no runner and starts no work: remembering, listing, correcting and forgetting work while every runner slot is busy, and post nothing beyond the reply to the member who asked.

### Unlink and revoke

- **Settings › Account** shows your own Slack link, with **Unlink**. Mentioning `@Paws unlink` in the channel unlinks the Slack account that posted it. Either way only your own link ends: the installation, the channel setup and other members' links stay as they are.
- On the Slack card in **Workspace › Integrations**, an admin sees each linked member, marked when their Paws access is revoked, and can **Revoke** a link. Only links in this Paws workspace are listed or changed. Disconnecting the installation stays an admin action on the same card.
- Unlinking or revoking ends the link at once. Paws drops that member's held question and unused link code, stops the turn it is running for them, and withholds replies to them it hadn't posted yet. Their next mention asks them to link again. Linking again starts fresh: mentions received before the unlink, and replies prepared for the earlier link, are never answered or posted. Paws checks the link once more just before it posts.
- A member whose Paws access is revoked, or whose membership ends, gets no answers and can't stop a thread, even while still linked.
- Unlinking again, or a Slack redelivery of `@Paws unlink`, changes nothing. Each change is in the workspace audit as `slack.member_unlinked` or `slack.member_revoked`, with who made it and which Slack account.

### Threads and Stop

Each thread Paws is mentioned in is recorded once, when the first signed mention from the connected installation arrives: the Slack workspace, installation, channel, thread, who mentioned Paws first and with which event, and the thread Paws replies in. Every later mention in the thread is stored with the Slack user who posted it. The record grants nothing: each answer still needs the checks above. Slack redeliveries, including one after Paws stored a mention but before Slack saw the answer, are acknowledged and produce no second turn.

A linked member mentions `@Paws stop` in the thread to stop it. Paws records the stop when the mention arrives, without waiting for a runner, so it works while every slot and the conversation lane are busy. It ends the turn that is running within about a second, never posts a reply to any mention made before the stop, and ignores a delayed delivery of one of those mentions. The member who stopped it sees a message only they can see. A mention after the stop starts a new turn. A stop from someone who isn't linked is treated as any other mention.

Each reply Paws posts has a **Stop** button. A click from a linked member stops the thread the same way, from the moment of the click, also while every slot and the conversation lane are busy. Paws checks each click's Slack signature, its age (at most five minutes) and that it comes from the connected Slack workspace and app; anything else is refused or ignored. Each click is stored, and one click per button counts: clicking the same button again, or Slack delivering it twice, has no further effect. A click from someone who isn't linked does nothing and doesn't use up the button.

`paws doctor` checks each connected Slack workspace: channel threads need the scopes above, and a missing one fails with a reconnect hint. App messages and agent status are shown as optional notes, and Slack Code is shown as not available; neither stops channel threads from working.

## Use a `paws login slack` connection

`paws login slack` connects Slack to the server rather than to a Paws workspace. When such a connection exists and the Paws workspace has none, the Integrations card offers **Use the paws login slack connection**. It moves that token, with the scopes it already has, into the admin's Paws workspace and removes the server-wide copy, without opening Slack or asking for new permissions. Paws refuses when the workspace is already connected, the Slack workspace belongs to another Paws workspace, the token rotates, or it was issued to an app other than `SLACK_APP_ID`. The move is recorded in the workspace audit as `slack.adopted`.
