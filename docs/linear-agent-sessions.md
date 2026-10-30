# Linear agent sessions

Linear is the issue tracker. GitHub authentication for repositories and pull requests is described in [GitHub App](github-app.md).

Paws runs work only for a configured Linear workspace, through a Linear OAuth app installed with `actor=app`, behind [Workspace access](workspace-access.md) with `PAWS_PUBLIC_DASHBOARD=1`. Without one, `bun run paws doctor` reports `linear-workspace` as missing and Paws starts no work.

Progress is posted with `agentActivityCreate`, and `ask_team` questions are elicitation activities on the delegated issue's agent session. That code lives in `src/linear`.

An install whose `config.toml` sets `mode = "comments"` under `[linear]`, or whose environment sets `LINEAR_MODE=comments`, gets a startup message and a missing `linear-mode` check from `bun run paws doctor`. Delete that setting; Paws runs agent sessions either way.

## One story per session

One Paws run is one Linear agent session. Linear derives the session's state from the last activity Paws sent, so Paws controls the story by controlling which activity kinds each work-item state may emit. Title (`summary` on `agentSessionUpdate`) and plan are session metadata, not activities: they move without changing the session's state. Both derive from the work-item state that `transition()` produced, the restart reason, and whether the pull request response exists. There is no second state machine for them.

### The post-PR rule

Before the pull request, activities tell the story and the title names the phase. After the pull request response, only the title and plan move, and exactly one more response closes the session.

`canReportProgress` in `src/loop/activity-policy.ts` is the only activity gate. Once a `pull-request-ready:`, `merged:` or `closed:` row exists for the session's generation, it drops every later thought, action, keepalive and evidence line. Three kinds pass it:

1. **The final response.** Merged (`merged:<item>:<generation>`), closed without merge (`closed:`), or stopped (`command:stop:`). It is delivered `ordered`, keeps the session complete, and ends it for good. A comment-only GitHub review's threads (`pull-review:`) are also a response, posted once per review id.
2. **Elicitations from `ask()`.** A question reopens a session after the pull request, because a person must see it.
3. **Feedback that sends the item back to the agent.** A changes-requested review or a batch of pull request comments that restarts the item posts one thought (`pull-feedback:<restart job key>`), such as "@reviewer requested changes on pull request #12. The agent is working on them." A change request on the risk approval posts one thought too (`risk-approval:`). The thought makes the session active again, so the delegator sees the agent pick up the feedback.

The pull request response and the final response end with what is still open at the published head, when anything is: "2 findings still open (1 P1 pre-existing, 1 P2 below failOn) and risk high (`a.ts`). Check them: <Paws issue page>". The findings are the review findings Closeout accepted the head with, pre-existing or below the review's `failOn`. Without a public dashboard URL the line says "Check them on the Paws dashboard." The pull request body has the same line and one line per finding under `## Open findings`, and every later publication rewrites it. The line goes in the same response; it never adds an activity.

Evidence published after the pull request response is attached to the issue (`linear.attachment`), not posted. See [Evidence checks](closeout.md#evidence-checks).

The host plan is monotonic. A completed host step (Wait, Implement, Verify, Fix findings, Open pull request, Merge) never returns to pending. Re-verification and fix rounds append a step, and the title never reads `implementing`, `verifying` or `fixing` again after the pull request.

### Restart reasons

`restart(item, reason)` in `src/loop` is the one way back to the agent. When an earlier resume was cancelled before the agent finished a turn on it (its run failed first, or the time limit stopped it), the next restart hands that text to the agent ahead of its own, once, whatever its reason. A review cut off that way still reaches the agent after a "retry" or a Continue. The reason picks the title and the appended plan step:

| Reason      | Cause                                          | Title while queued                                     | Title while running               |
| ----------- | ---------------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `findings`  | Closeout rejected the candidate                | waiting for a runner to fix Closeout findings (k of n) | fixing Closeout findings (k of n) |
| `ci`        | CI failed on the pull request head             | waiting for a runner to fix CI (k of n)                | fixing CI (k of n)                |
| `review`    | A changes-requested review on the pull request | waiting for a runner to address the review (k of n)    | fixing review findings (k of n)   |
| `conflict`  | The merge lane's rebase conflicted             | waiting for a runner to resolve a merge conflict       | resolving merge conflict          |
| `follow_up` | A person's message in the session              | the ordinary queued face                               | the ordinary running face         |
| `answer`    | A person's guidance in reply to a question     | the ordinary queued face                               | the ordinary running face         |

`n` is the limit that stops the item first. For CI and review rounds it is `retry.fix_rounds_per_item`. For Closeout findings it is the lower of that and the last fix the failed checks allow: each failed check has `retry.attempts_per_check` less its failed attempts so far left, and if it keeps failing it is exhausted after that many more fixes. `n` is worked out again each round, so it can grow when a different check starts failing. Evidence checks have no attempt limit. The first four reasons append a plan step: Fix Closeout findings (k of n), Fix CI, Fix review findings or Resolve merge conflict. When the agent's fix reaches `verifying` after the pull request, that step completes, a **Verify fixes** step is appended, and the title reads "checking fixes". Before the pull request, a restart posts one thought naming the reason, once per round. After it, a restart moves the title and plan, and a `review` restart from GitHub review feedback also posts the one `pull-feedback:` thought naming who asked for changes.

### The face table

Each work-item state has one face. Titles are prefixed with the issue identifier, for example `PAS-619: waiting for PAS-618`.

| State                                    | Linear session                       | Title                                                                                | Plan step                           | Activity allowed                                                                                                                      |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `planning`                               | active                               | unchanged                                                                            | unchanged                           | None. The item waits for `plan_approved` and then enters `queued`.                                                                    |
| `queued`, blocked                        | active                               | waiting for PAS-m                                                                    | Wait for PAS-m, in progress         | One thought naming the blocker; an ephemeral "Still waiting for PAS-m." every 25 minutes                                              |
| `queued`, no runner slot                 | active                               | 2nd in line for a runner                                                             | Wait for a runner, in progress      | The same, with the queue position                                                                                                     |
| `queued` after a restart                 | active before the PR, complete after | waiting for a runner to … (see [Restart reasons](#restart-reasons))                  | the appended step, in progress      | Before the PR, the same ephemeral; after the PR, none                                                                                 |
| `paused`                                 | active                               | paused by <who>                                                                      | current step, in progress           | One thought; no ephemeral while paused                                                                                                |
| `recovering`                             | active                               | recovering an interrupted turn                                                       | current step, in progress           | One thought                                                                                                                           |
| `running`                                | active                               | implementing (preparing answer, creating files, or planning sub-issues by task mode) | Implement, with the agent's steps   | `post_update` thoughts; an ephemeral keepalive every 25 minutes carrying the current agent step                                       |
| `running` after a restart, before the PR | active                               | fixing … (see [Restart reasons](#restart-reasons))                                   | the appended step, in progress      | One thought naming the reason; `post_update` thoughts; keepalive with the step                                                        |
| `running` after a restart, PR exists     | complete                             | the same titles                                                                      | the same appended steps             | For review feedback, the one `pull-feedback:` thought (active); otherwise none. A question goes through `ask()`                       |
| `awaiting_input`                         | awaitingInput                        | unchanged                                                                            | unchanged                           | One elicitation from `ask()`, and nothing else until it is answered. Allowed after the PR                                             |
| `verifying`                              | active                               | verifying                                                                            | Verify, in progress                 | One thought per Closeout verdict, evidence bundled                                                                                    |
| `verifying` after a rebase, PR exists    | complete                             | rebased onto main, re-verifying                                                      | Re-verify after rebase, in progress | None; evidence is attached to the issue                                                                                               |
| `verifying` after a fix, PR exists       | complete                             | checking fixes                                                                       | Verify fixes, in progress           | None; evidence is attached to the issue                                                                                               |
| publishing                               | active                               | publishing                                                                           | Open pull request, in progress      | None until the pull request response, which completes the session                                                                     |
| `merge_queue`                            | complete                             | CI running, rebased, re-verifying, 2nd in queue or merging                           | Merge, in progress                  | The pull request response once, with the PR as an external URL; nothing after                                                         |
| `merged`                                 | complete                             | completed                                                                            | all completed                       | Final response "Merged #N into main at <sha>. PAS-n is Done."; the issue moves to Done                                                |
| `completed`                              | complete                             | completed                                                                            | all completed                       | One response with the answer, the files, or for a plan outcome the created sub-issues or "Discarded the proposal. Nothing was filed." |
| `failed`                                 | error                                | unchanged                                                                            | current step                        | One error with the cause (crash budget, run failure, start timeout). After the PR, a `Closed: …` response instead                     |
| `manual`                                 | complete                             | manual                                                                               | remaining steps canceled            | Response "Taken over by <who>. Paws will not restart, verify or merge PAS-n."                                                         |
| `cancelled`, stopped                     | complete                             | stopped                                                                              | remaining steps canceled            | Response "Stopped. Branch paws/PAS-n has k commits; PR #N is open. Re-delegate to continue."                                          |

Publishing is a phase of `verifying` and `merge_queue`, not a work-item state. Spent budgets are questions in `awaiting_input`, never `failed`.

Linear's stop button, the `stopping` status and a `/paws stop` reply all end in the one stop response. It is built from the run's last known branch state: the branch, its commit count, and whether a pull request is open, will be closed, or was never opened.

The keepalive (`KEEPALIVE_MS` in `src/loop/activity.ts`, `WAIT_KEEPALIVE_MS` in `src/scheduler/waits.ts`) is 25 minutes, below Linear's 30-minute stale window (`LINEAR_STALE_MS`). Its body is the agent's current plan step, else the last `post_update` line, else the phase. A lifecycle thought with an identical body is not posted twice within one phase.

### A first delegation

A delegator who has never signed in to Paws gets the same one session, with a short setup prefix before the ordinary faces. Paws never opens a second session for onboarding and never writes to Linear while it waits. Who may delegate, the onboarding page and the link rules are in [Workspace access](workspace-access.md#a-first-delegation).

| #   | When                                           | Activity                                                                                                                                                                                                                                                                                         | Linear session |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 1   | The delegation arrives                         | Thought "Picked up this issue.", within 10 seconds, as for everyone                                                                                                                                                                                                                              | active         |
| 2   | The delegator has no Paws membership           | One auth elicitation addressed to the delegator: "Welcome to Paws. Sign in with Linear so I can start PAS-n. I'll start on my own once you're set up. You can Stop this anytime." and "Optional: link GitHub on the next page so your commits credit you." Its action opens `/onboard/<link id>` | awaitingInput  |
| 3   | The delegator replies before signing in        | Nothing. The reply is kept and delivered to the agent when the run starts. A reply from anyone else is dropped                                                                                                                                                                                   | awaitingInput  |
| 4   | Signed in, and no runner the delegator may use | One thought: "You don't have a runner Paws can use yet. Create a VM or add a host here: <origin>/status/runners. I'll start on my own once it's ready."                                                                                                                                          | active         |
| 4   | Signed in, the runner lacks the agent          | One thought: "Your runner <name> needs <agent> signed in. Sign in on the Runners page; I'll start right after."                                                                                                                                                                                  | active         |
| 5   | A runner becomes usable                        | One thought: "Starting PAS-n on <runner>.", then the ordinary `running` face                                                                                                                                                                                                                     | active         |
| 6   | The work merges                                | The pull request response, then the final "Merged #N into main at <sha>. PAS-n is Done." The commits carry the delegator's `Co-authored-by` trailer when they linked GitHub                                                                                                                      | complete       |

A delegator who signs in and already has a usable runner skips step 4 and the "Starting" thought of step 5. A member who is already set up sees only steps 1 and 6 around the ordinary faces. Each thought is posted once per hold: a runner that comes and goes, or a page that is reloaded, posts nothing more. When Paws cannot tell what is missing, step 4 is the general line "PAS-n waits for a runner you can use. Add one on the Runners page and sign in to its agent, or ask your project lead to share theirs. Paws starts PAS-n on its own once a runner is ready." While held, the item is not in the slot line, so it gets no queue position, no start timeout and no retries.

The setup can also end early, each time with at most one activity:

| Cause                                                                   | Activity                                                                                                                             | Linear session    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| No sign-in within one day                                               | Response "This sign-in link expired. Delegate the issue again to retry."                                                             | complete          |
| The delegator is a guest or outside the issue's team                    | Error "Paws did not start this work. <reason>" (reasons in [Admission](workspace-access.md#admission))                               | error             |
| The issue's team, state or delegate changed before the resume           | Error "Paws did not start this work. This issue changed while Paws waited for you to sign in."                                       | error             |
| The team has no repository Paws may use, or the repository isn't mapped | Response with the reason, such as "ENG has no repository in Paws yet. Ask <admins> to map one in Integrations, then delegate again." | complete          |
| The delegator presses Stop                                              | None from the hold: it ends with its link, and nothing starts                                                                        | stopped in Linear |

`test/first-delegation-budget.test.ts` holds a first delegation to 30 Linear requests or fewer, with none while it waits.

### Measuring the story

The outbox records every post, so these queries show whether sessions follow the rule. The live run of them is tracked in PAS-744.

```sql
-- Merged items whose session got a final response.
SELECT COUNT(*) AS merged,
  SUM(EXISTS (SELECT 1 FROM outbox o WHERE o.target = 'linear'
    AND o.idempotency_key LIKE 'merged:' || w.id || ':%' AND o.status = 'sent')) AS announced
FROM work_item w WHERE w.state = 'merged';

-- Activities after the PR response per session generation (target: 1, the final response).
SELECT p.ordering_key, p.delivery_generation, COUNT(o.id) AS after_pr
FROM outbox p
JOIN outbox o ON o.target = 'linear' AND o.ordering_key = p.ordering_key
  AND o.delivery_generation = p.delivery_generation AND o.id > p.id
  AND o.op = 'activity' AND o.status = 'sent'
WHERE p.target = 'linear' AND p.idempotency_key LIKE 'pull-request-ready:%' AND p.status = 'sent'
GROUP BY p.ordering_key, p.delivery_generation;

-- Title updates and plan replaces per session, on average.
SELECT op, AVG(n) FROM (
  SELECT op, ordering_key, COUNT(*) AS n FROM outbox
  WHERE target = 'linear' AND op IN ('linear.session.summary', 'linear.session.plan')
  GROUP BY op, ordering_key
) GROUP BY op;

-- Bare "Working on" keepalives (target: 0).
SELECT COUNT(*) FROM outbox
WHERE target = 'linear' AND op = 'activity' AND json_extract(payload, '$.body') LIKE 'Working on %';
```

## Linear API findings

The notes below are from Linear's docs and the published GraphQL operations, plus what Pascal should confirm in a workspace.

### What we needed to know

1. Does delegating an issue create an `AgentSession` that `agentSessions` polling can see?
2. Do agent activities render when the OAuth app has no webhook URL?

### Findings

#### Delegation and `agentSessions`

An `AgentSession` is created when an **agent** is @mentioned or delegated an issue. Delegation means the issue's delegate is the app user (`Issue.delegate`), which requires an OAuth app installed with `actor=app` and the `app:assignable` scope. A mention requires `app:mentionable`. Assigning the issue to a human is not an agent delegation and does not create an agent session.

The schema exposes a root query `agentSessions` (pagination, `orderBy` of `createdAt` or `updatedAt`). Each session has `id`, `createdAt`, `updatedAt`, `issue`, and `appUser`. The query has no webhook argument. `src/linear/catchup.ts` already polls it. A session that exists is therefore visible without a webhook delivery succeeding.

Linear's docs separate two facts:

- The session is created on mention or delegation.
- The Agent Session UI appears once the app subscribes to `AgentSessionEvent` webhooks. That happens as soon as the category is enabled, even if the subscription is only for debugging.

We read that as: the row is probably inserted either way, and the UI is not. The docs do not say the row is skipped when the category is off, and they do not say it is inserted when the category is off. That is the open point in the manual checks.

#### Activities with no webhook URL

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
