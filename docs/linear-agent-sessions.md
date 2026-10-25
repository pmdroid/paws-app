# Linear agent sessions

Linear is the issue tracker. GitHub authentication for repositories and pull requests is described in [GitHub App](github-app.md).

Paws runs work only for a configured Linear workspace, through a Linear OAuth app installed with `actor=app`, behind [Workspace access](workspace-access.md) with `PAWS_PUBLIC_DASHBOARD=1`. Without one, `bun run paws doctor` reports `linear-workspace` as missing and Paws starts no work.

Progress is posted with `agentActivityCreate`, and `ask_team` questions are elicitation activities on the delegated issue's agent session. That code lives in `src/linear`.

An install whose `config.toml` sets `mode = "comments"` under `[linear]`, or whose environment sets `LINEAR_MODE=comments`, gets a startup message and a missing `linear-mode` check from `bun run paws doctor`. Delete that setting; Paws runs agent sessions either way.

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

## Item history

Every committed work-item transition writes one `work_item_event` row in the same transaction as the state change (`applyWorkItemEvent` in `src/db/items.ts`). The row carries the item, the version the transition produced, the time, `from_state`, `to_state`, the `transition()` event, a `kind` and an optional `reason`, `payload_digest` and `actor`. A transition that sends the item back to the agent is kind `restart` with reason `findings`, `ci`, `review`, `conflict`, `follow_up` or `answer`. One that asks a person is kind `ask` with the ask reason. The issue page on the status dashboard shows the rows as the item timeline.

The flow metrics read this table:

```sql
-- Fix rounds per merged item.
SELECT w.id, COUNT(e.id) AS fix_rounds
FROM work_item w
LEFT JOIN work_item_event e
  ON e.item_id = w.id AND e.kind = 'restart' AND e.reason IN ('findings','ci','review')
WHERE w.state = 'merged'
GROUP BY w.id;

-- Rebase returns per merged item.
SELECT w.id, COUNT(e.id) AS rebase_returns
FROM work_item w
LEFT JOIN work_item_event e ON e.item_id = w.id AND e.kind = 'restart' AND e.reason = 'conflict'
WHERE w.state = 'merged'
GROUP BY w.id;

-- Questions per item, and visual review requests.
SELECT item_id, COUNT(*) AS questions, SUM(reason = 'visual_review') AS visual_reviews
FROM work_item_event WHERE kind = 'ask' GROUP BY item_id;
```

Items created before migration `145_work_item_event` have no rows for their earlier transitions.

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
