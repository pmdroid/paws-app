# Linear agent sessions

Linear is the issue tracker. GitHub authentication for repositories and pull requests is described in [GitHub App](github-app.md).

Paws runs work only for a configured Linear workspace, through a Linear OAuth app installed with `actor=app`, behind [Workspace access](workspace-access.md) with `PAWS_PUBLIC_DASHBOARD=1`. Without one, `bun run paws doctor` reports `linear-workspace` as missing and Paws starts no work.

Progress is posted with `agentActivityCreate`, and `ask_team` questions are elicitation activities on the delegated issue's agent session. That code lives in `src/linear`.

An install whose `config.toml` sets `mode = "comments"` under `[linear]`, or whose environment sets `LINEAR_MODE=comments`, gets a startup message and a missing `linear-mode` check from `bun run paws doctor`. Delete that setting; Paws runs agent sessions either way.

## A first delegation

A Linear user who has never used Paws delegates an issue to the Paws app, or @mentions it. Everything below happens in that one agent session. Paws never opens a second session for onboarding. Sign-in and the onboarding page are described in [Workspace access](workspace-access.md#first-time-members).

1. **Thought:** "Picked up this issue." Paws posts it within the 10 second window, before it knows who the delegator is.
2. **Sign-in action.** When the delegator has no Paws account, Paws holds the delegation and posts one auth elicitation from Paws, addressed to the session's creator. Its link opens `/onboard/<link id>`. The text is:

   > Welcome to Paws. Sign in with Linear so I can start PAS-1. I'll start on my own once you're set up. You can Stop this anytime.
   >
   > Optional: link GitHub on the next page so your commits credit you.

   Paws posts no error before it and does not repeat it. While the delegation waits, Paws writes nothing to Linear.

3. **Replies while waiting.** A reply from the delegator is kept. Paws delivers it to the run when the work starts, and it posts nothing in the meantime. Replies from anyone else are dropped.
4. **No usable runner.** After sign-in, the delegation resumes in the same session. If the delegator has no runner Paws may use, the session gets one thought and the item waits without retrying or timing out. The hold keeps that first thought. When the missing piece changes, for example from a runner to an agent sign-in, Paws posts nothing new, and the onboarding page shows the current step. The thought is one of these:
   - "You don't have a runner Paws can use yet. Create a VM or add a host here: <Paws>/status/runners. I'll start on my own once it's ready."
   - "Your runner <name> needs Claude signed in. Sign in on the Runners page; I'll start right after." The agent name is the one the task needs.
   - "PAS-1 waits for a runner you can use. Add one on the Runners page and sign in to its agent, or ask your project lead to share theirs. Paws starts PAS-1 on its own once a runner is ready." Paws posts this when it cannot name what is missing, such as when the delegator's runner is offline.
5. **Thought:** "Starting PAS-1 on <runner>." Paws posts it when a runner the delegator may use becomes ready. The check runs when a runner enrolls, a member VM is ready, a runner comes back online, an agent sign-in becomes ready, or a lead turns sharing on. It reads only the Paws database and never polls Linear. The work then runs as any other delegation does, with the progress updates, pull request and merge.
6. **Busy runners.** When every runner the delegator may use is busy, the session gets a queue thought such as "Queued, 1st in line. 2 of 2 runner slots are busy. Paws starts PAS-1 when a slot frees." Only runners the delegator may use count, and the start timeout applies only to them.

### When Paws does not start the work

Each case tells the session why, once.

| Situation                                                          | What the session shows                                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The delegator is a Linear guest                                    | Error: "Paws did not start this work. Linear guests cannot delegate issues to Paws. Ask a member of <team> to delegate this issue."                   |
| The delegator is not in the issue's team                           | Error: "Paws did not start this work. You are not a member of this issue's Linear team."                                                              |
| The delegator is a Paws observer                                   | Error: "Paws did not start this work. Observers in the Paws workspace cannot delegate issues to Paws. Ask a member of <team> to delegate this issue." |
| The issue, its team, or the repositories changed while Paws waited | Error: "Paws did not start this work. This issue changed while Paws waited for you to sign in."                                                       |
| Nobody signed in within a day                                      | Response, which ends the session: "This sign-in link expired. Delegate the issue again to retry."                                                     |
| The team has no repository in Paws                                 | Response, which ends the session: "<team> has no repository in Paws yet. Ask <owners and admins> to map one in Integrations, then delegate again."    |
| The chosen repository is not mapped to the team                    | Response, which ends the session: "<owner/repo> isn't mapped to <team> in Paws."                                                                      |
| Every usable runner stayed busy past the queue timeout             | Error: "Paws couldn't start PAS-1 within <hours> because every runner slot stayed busy. Delegate it again to retry."                                  |

A team without any repository mapping may use any repository in the catalog. The repository hint or Linear's repository suggestion picks it.

### Credit

When the delegator linked GitHub on the onboarding page or in **Settings > Account**, each commit carries a `Co-authored-by` trailer with their GitHub noreply address, and the pull request body credits their login. Without the link, the Paws App bot is the only author. The details are in [GitHub App](github-app.md).

### Linear requests

A first delegation from an unknown user, through sign-in, resume, run and merge, makes at most 30 Linear requests. Waiting for sign-in, a runner, or an agent sign-in makes none. `test/first-delegation-budget.test.ts` enforces the bound with fakes. On a live instance, `/health` lists the requests per issue under `linear.items` for the last hour.

## Research notes

Nothing in this tree calls Linear; the notes below are from Linear's docs and the published GraphQL operations, plus what Pascal should confirm in a workspace.

## What we needed to know

1. Does delegating an issue create an `AgentSession` that `agentSessions` polling can see?
2. Do agent activities render when the OAuth app has no webhook URL?

## Findings

### Delegation and `agentSessions`

An `AgentSession` is created when an **agent** is @mentioned or delegated an issue. Delegation means the issue's delegate is the app user (`Issue.delegate`), which requires an OAuth app installed with `actor=app` and the `app:assignable` scope. A mention requires `app:mentionable`. Assigning the issue to a human is not an agent delegation and does not create an agent session.

The schema exposes a root query `agentSessions` (pagination, `orderBy` of `createdAt` or `updatedAt`). Each session has `id`, `createdAt`, `updatedAt`, `issue`, and `appUser`. The query has no webhook argument. `src/linear/catchup.ts` already polls it. A session that exists is therefore visible without a webhook delivery succeeding.

Linear's docs separate two facts:

- The session is created on mention or delegation.
- The Agent Session UI appears once the app subscribes to `AgentSessionEvent` webhooks. That happens as soon as the category is enabled, even if the subscription is only for debugging.

We read that as: the row is probably inserted either way, and the UI is not. The docs do not say the row is skipped when the category is off, and they do not say it is inserted when the category is off. That is the open point in the manual checks.

### Activities with no webhook URL

`agentActivityCreate` is a GraphQL mutation keyed by `agentSessionId`. It does not take a webhook URL. Activities render in the Agent Session UI. Linear shows that UI only after the app subscribes to `AgentSessionEvent`.

Getting started tells you to enable webhooks on the OAuth application and select **Agent session events**. That form takes a webhook endpoint URL. The docs do not describe enabling the category with a blank URL. With no webhook URL, the category stays off, the session UI stays off, and activities do not render there.

A `response`, `elicitation`, or `error` activity also creates a comment in the thread. That comment is a side effect of an activity on a session.

A created session must receive an activity, or an `externalUrls` update, within 10 seconds or Linear marks it unresponsive. Later activities can go stale after 30 minutes. The catch-up poll runs once at start, then every 12 minutes, or once a minute while webhooks look broken (`POLL_INTERVAL_WEBHOOK_MS`, `POLL_INTERVAL_FAILING_MS` in `src/linear`). Neither meets the 10 second window, so the first activity comes from the webhook handler.

Ephemeral `thought` and `action` activities are replaced in the session UI by the next activity. That display exists only in the session UI.

## What Pascal should verify

These need a real Linear workspace. Do not point a webhook at a tunneled laptop for them.

1. OAuth app installed with `actor=app` and `app:assignable`. Leave **Agent session events** off and set no webhook URL. Delegate an issue to the app. Query:

   ```graphql
   query {
     agentSessions(first: 20, orderBy: updatedAt) {
       nodes {
         id
         createdAt
         issue {
           id
         }
         appUser {
           id
         }
       }
     }
   }
   ```

   Record whether a row appears, and whether the issue shows any Agent Session UI.

2. Enable **Agent session events** with a real webhook URL. Delegate again. Confirm a row in `agentSessions` and the session UI on the issue.
3. Point that URL at a host that does not answer. Delegate, poll `agentSessions` until the new id appears, then immediately call `agentActivityCreate` with a `thought`. Record whether it renders, and whether waiting past 10 seconds with no activity shows the session as unresponsive.
4. If step 1 returned a session id, call `agentActivityCreate` anyway. Record whether anything renders on the issue.

## Sources

- [Developing the Agent Interaction](https://linear.app/developers/agent-interaction) — session created on mention or delegation; UI appears when you subscribe to `AgentSessionEvent`; 10 second first activity; `agentActivityCreate`; proactive `agentSessionCreateOnIssue`.
- [Getting started with agents](https://linear.app/developers/agents) — enable webhooks and select Agent session events; `actor=app`; `app:assignable` / `app:mentionable`; delegate is not the assignee.
- [Interaction best practices](https://linear.app/developers/agent-best-practices) — first activity within 10 seconds; stale after 30 minutes; `response` / `elicitation` / `error` also create a comment; read activities rather than comments for agent sessions.
- [Building the Agent Interaction SDK](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk) — app user, assignable and mentionable scopes, session as the interaction object, webhook on create.
- Schema operations in [`@linear/sdk` generated documents](https://github.com/linear/linear/blob/master/packages/sdk/src/_generated_documents.graphql): `query agentSessions`.
