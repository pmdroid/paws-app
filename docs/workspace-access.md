# Workspace access

Configure a Linear OAuth app with these callback URLs for your Paws HTTPS origin:

- `/auth/linear/callback` for personal sign-in.
- `/auth/linear/install/callback` for the workspace app authorization.

Set `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` on the server. Set the GitHub App credentials described in [GitHub App](github-app.md) so workspace owners can connect repositories in Integrations.

Give Paws a valid TLS certificate and its matching private key. The key must be readable by the Paws process and have mode `0400` or `0600`.

```sh
PAWS_PUBLIC_DASHBOARD=1 \
PAWS_PUBLIC_URL=https://paws.example.com:8787 \
PAWS_HOST=0.0.0.0 \
PAWS_PORT=8787 \
PAWS_TLS_KEY_PATH=/etc/paws/tls.key \
PAWS_TLS_CERT_PATH=/etc/paws/tls.crt \
bun run paws --no-tunnel
```

Open the dashboard and select **Sign in with Linear**. A Linear workspace admin completes the personal sign-in and approves installing Paws into that same workspace. Paws rechecks their admin membership through the new app authorization, stores encrypted credentials, creates the owner's workspace, and starts the connected service automatically. The owner continues to **Integrations** to connect GitHub and map repositories to Linear teams.

If Linear revokes the app authorization, the dashboard offers **Reconnect Linear**. A workspace admin signs in and authorizes the same installation again. Paws preserves the workspace and its roles.

Subsequent members use **Sign in with Linear** to open the workspace. A connected instance verifies each user's current membership against its installed Linear workspace.

Owners can assign Paws roles and map repositories to verified Linear teams in the workspace controls. Linear guests receive observer access. Membership refresh updates team visibility and revokes sessions when a member loses access. Sign out ends the current browser session. Each visit extends the session; it expires after thirty days without use. The dashboard shows only the sign-in page until you sign in.

## Admission

There is one admission mode: automatic. No admin approves a new member. When a person signs in with Linear, Paws reads their current Linear membership and creates their Paws membership: `member` for a Linear member, `observer` for a Linear guest. A role an owner set by hand survives later syncs.

Who may delegate an issue to Paws is decided when the delegation arrives, with the person's live Linear membership (`canAct` in `src/workspace/eligibility.ts`). Each refusal ends the session with an error that starts "Paws did not start this work.":

| Delegator                           | Reason in the error                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Inactive Linear account             | Your Linear account is not active.                                                                             |
| Linear guest                        | Linear guests cannot delegate issues to Paws. Ask a member of <team> to delegate this issue.                   |
| Not in the issue's Linear team      | You are not a member of this issue's Linear team.                                                              |
| Paws observer                       | Observers in the Paws workspace cannot delegate issues to Paws. Ask a member of <team> to delegate this issue. |
| Inactive Paws membership            | Your Paws workspace membership is not active.                                                                  |
| Active team member, never signed in | No error. Paws holds the delegation and posts one sign-in action (below).                                      |

## A first delegation

A Linear member who has never signed in to Paws can delegate an issue anyway. Paws holds the delegation instead of refusing it, and the same Linear session carries the person through setup. What the session shows is in [Linear agent sessions](linear-agent-sessions.md#a-first-delegation).

1. The delegator presses **Sign in to Paws** in the session. It opens `/onboard/<link id>`, which starts Linear sign-in.
2. After sign-in, Paws creates the membership as in [Admission](#admission), releases the hold, and redirects to `/onboard/<link id>`, now the onboarding page.
3. The onboarding page lists the steps in order. Each step is a database fact; the page re-reads itself every 15 seconds (every 3 seconds while a VM is being set up) and never reads Linear.

| Step             | Done when                                                                                                    | Otherwise                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear           | Always, once signed in: "Signed in as <email>."                                                              | —                                                                                                                                                                                                                                                                                                                                                             |
| Membership       | Active member of the issue's team: "Member of <team>."                                                       | An observer reads that observers cannot own work and should ask a workspace member to delegate. Someone outside the team is asked to have a team admin add them.                                                                                                                                                                                              |
| Runner           | An eligible runner: "<runner> will run this task.", or "<lead>'s shared runner <runner> will run this task." | **Create VM** (when Paws can create one and the member has no VM) and **Add a host**. Create VM shows its four steps (Create the VM, Install the runner, Enroll with Paws, First heartbeat); a failed setup offers **Retry**. Add a host asks for a host name and shows a one-time enrollment command. An offline or paused runner is named, with what to do. |
| Claude and Codex | Both are signed in on the chosen runner                                                                      | **Sign in on <runner>**, which opens the runner on the Runners page. On a lead's shared runner, the page asks the delegator to ask the lead. Before a runner exists, the step reads "After the runner".                                                                                                                                                       |
| GitHub credit    | Linked: "Commits will credit @<login>."                                                                      | Optional. A consent box and **Link GitHub**; GitHub returns the member to this page. Skipping it is fine: the commits are by the Paws App only.                                                                                                                                                                                                               |

The heading reads "Welcome, <first name>" and the lead line counts the remaining steps ("2 more steps before Paws starts PAS-n."). Once nothing is missing it reads "You're set up. Paws runs PAS-n on <runner>." The member can close the tab: Paws starts the task by itself once the runner and its agents are ready (see [Automatic start](#automatic-start)).

A runner is eligible when it is the delegator's own, or when it is shared and belongs to the lead of a Linear project in the delegation. Only the owner of a runner can sign its agents in or share it. Observers are offered neither Create VM nor Add a host. How Create VM works is in [Create a VM](create-vm.md); Add a host is [Enroll a remote Linux runner](runner-enrollment.md); the credit link is in [GitHub App](github-app.md#credit-link).

### Automatic start

The resume never waits on a clock. A runner heartbeat, an agent sign-in becoming ready, a runner being shared, or a member VM reaching `ready` queues one `runner_setup.check` for the delegator, which reads SQLite only. If an eligible runner now has the agent ready, the item leaves its hold and the scheduler places it by the normal checks.

### Repository access

Repository access comes from the Linear team to repository mapping in Integrations. A team with mappings uses only those repositories; a team without any may use any repository in the catalog. A delegation Paws cannot place ends with one response that says why, instead of "Cancelled from Linear.":

- "<team> has no repository in Paws yet. Ask <owners and admins> to map one in Integrations, then delegate again."
- "<owner/repo> isn't mapped to <team> in Paws."
- "You're not a member of <team> in Paws."

## Onboarding link rules

- **The link is an address, not a credential.** `/onboard/<link id>` uses a random 26-character id that grants nothing by itself. Authority comes only from Linear OAuth (PKCE, a browser cookie, and a single-use `state` that lives ten minutes). That is why the link may sit in Linear's activity data and in logs.
- **Only the session creator.** If someone else signs in through the link, Paws answers "This link belongs to <name>." with HTTP 403. It records their own membership as in [Admission](#admission), but does not sign them in to the dashboard and leaves the hold as it was. After onboarding, the link shows the page only to its signed-in creator; everyone else gets the same 404 as an unknown link ("This sign-in link is not active.").
- **Expiry.** The link works while its hold is pending, for at most one day (`ONBOARDING_HOLD_MS`). After that Paws posts one final response, "This sign-in link expired. Delegate the issue again to retry.", and ends the session. A stopped or replaced session ends its link too.
- **One action per session.** Waiting writes nothing to Linear. A session generation gets one sign-in action and never a second one. Signing in from the dashboard instead of the link releases the same hold.
- **Rate limits.** In memory: 10 visits to `/onboard/*` per client IP per minute, 20 sign-in starts per link per day, and 5 failed Linear callbacks per IP per ten minutes. Over a limit Paws answers 429 with `Retry-After` and "Too many sign-in attempts. Try again later." Nothing reaches Linear or the outbox.
- **Old links.** `/auth/linear?assignment=…` links, which carried a secret in the query string, answer 410: "This sign-in link was replaced. Use the latest Sign in to Paws action in Linear." A hold that was pending at upgrade got one new-form link.
- Paws logs never contain OAuth codes, `state` values or cookies.
