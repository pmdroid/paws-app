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

## First-time members

A Linear user who has never signed in to Paws can still delegate an issue to it. Paws holds the delegation, posts one sign-in action in the same Linear session, and starts the work on its own once the delegator is set up. What the session shows is in [Linear agent sessions](linear-agent-sessions.md#a-first-delegation).

1. The delegator selects **Sign in to Paws** in the session. The link is `/onboard/<link id>` on the Paws origin.
2. Paws starts Linear OAuth. After the callback, Paws re-reads the person's Linear membership and creates their Paws account.
3. When the signer is the session's creator, Paws sends them to the onboarding page at the same `/onboard/<link id>` address. The hold is released, and the delegation resumes in the same session and run.
4. The onboarding page lists five steps. The page re-reads itself every 15 seconds, or every 3 seconds while a VM is being set up. Each read uses only the Paws database. The member can close the tab, and onboarding continues without it.

| Step             | Done when                                                        | Otherwise the page offers                                                                                                                         |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear           | Always, once signed in. It shows "Signed in as <email>."         | Nothing.                                                                                                                                          |
| Membership       | The member is active, not an observer, and in the issue's team.  | A reason: not in the team ("Ask a team admin to add you."), or an observer.                                                                       |
| Runner           | A runner Paws may use for this task is ready.                    | **Create VM** (when Paws has an exe.dev token and the member has no VM) and **Add a host**. An offline or paused runner says who should start it. |
| Claude and Codex | Both agents are signed in on that runner.                        | **Sign in on <runner>**, which opens the runner's page. For a lead's shared runner, it asks the lead to sign in.                                  |
| GitHub credit    | The member linked GitHub. It shows "Commits will credit @login." | An optional **Link GitHub** form with a consent box. Paws starts without it.                                                                      |

The runner step names the runner that will run the task, either "<runner> will run this task." or "<lead>'s shared runner <runner> will run this task." A runner qualifies when the delegator owns it, or when the lead of a Linear project in the delegation owns it and shares it. Create VM shows its progress in place: create the VM, install the runner, pair with Paws, first heartbeat. A failed setup shows the error and **Retry**, which resumes from the failed step. Add a host asks for a host name and prints one command with a single-use enrollment token. The steps are described in [Create a runner VM on exe.dev](create-vm.md) and [Pair a remote Linux runner](runner-pairing.md).

When every step except GitHub credit is done, the page says "You're set up. Paws runs <issue> on <runner>." The **Link GitHub** form returns to the onboarding page after GitHub's consent screen.

A delegator who signs in from the dashboard instead of the link is treated the same way. Paws releases that person's pending holds at sign-in, without posting a second action. A sweep that runs every minute also releases a hold whose creator gained a membership another way, such as a membership sync.

### Admission

Admission is automatic. An active Linear member who is not a guest and belongs to the issue's team becomes a Paws `member` when they sign in. No admin approves it. A Linear guest signs in as an `observer`. Observers can view the dashboard, but they cannot own runnable work, create a VM, enroll a runner, or link GitHub credit. A delegation by an observer ends with "Observers in the Paws workspace cannot delegate issues to Paws. Ask a member of <team> to delegate this issue." Paws has no approval setting.

### Link rules

- **The link is an address, not a credential.** The link id is 26 random characters and grants nothing by itself. Authority comes only from Linear OAuth. OAuth `state` and the PKCE browser cookie are single-use and expire after ten minutes.
- **Only the session creator may use it.** Anyone else who signs in through the link sees "This link belongs to <name>." with HTTP 403. The hold does not move, and that person gets no Paws session from it.
- **It lasts one day.** A hold lives for 24 hours from the delegation. After that, Paws posts one final response, "This sign-in link expired. Delegate the issue again to retry.", and ends the session. An expired, unknown, stopped, or replaced link answers 404.
- **After onboarding, only the creator can open it.** A finished link shows its signed-in creator the onboarding page with the task's state. Anyone else, signed in or not, gets 404.
- **One action per session.** A session gets one sign-in action. Paws posts nothing to Linear while it waits.
- **Rate limits.** Limits are in memory, keyed by client IP or link id. Over a limit, Paws answers 429 with `Retry-After` and writes nothing to Linear.

| Limit                           | Allowed          |
| ------------------------------- | ---------------- |
| Opening `/onboard/*`, per IP    | 10 per minute    |
| Starting sign-in, per link      | 20 per day       |
| Failed Linear callbacks, per IP | 5 per 10 minutes |

- **Old links.** Links of the form `/auth/linear?assignment=…` carried a secret and are retired. They answer 410 with "This sign-in link was replaced. Use the latest Sign in to Paws action in Linear." A hold that was still pending at upgrade gets one new-form link.
- **Fail closed.** A missing hold, an expired link, the wrong signer, a stopped session, or a failed membership check leaves the item held or ends it. None of them starts work.

## Roles and sessions

Owners can assign Paws roles and map repositories to verified Linear teams in the workspace controls. Linear guests receive observer access. Membership refresh updates team visibility and revokes sessions when a member loses access. Sign out ends the current browser session. Each visit extends the session; it expires after thirty days without use. The dashboard shows only the sign-in page until you sign in.
