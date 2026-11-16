# Workspace access

Configure a Linear OAuth app with these callback URLs for your Paws HTTPS origin:

- `/auth/linear/callback` for personal sign-in.
- `/auth/linear/install/callback` for the workspace app authorization.

Set `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` on the server. Before the first installation, set `LINEAR_ORGANIZATION_ID` to the ID of the Linear workspace this Paws instance will serve. Paws accepts installation only for that organization. Set the GitHub App credentials described in [GitHub App](github-app.md) so workspace admins can connect repositories in Integrations.

Give Paws a valid TLS certificate and its matching private key. The key must be readable by the Paws process and have mode `0400` or `0600`.

```sh
PAWS_PUBLIC_DASHBOARD=1 \
PAWS_PUBLIC_URL=https://paws.example.com:8787 \
PAWS_HOST=0.0.0.0 \
PAWS_PORT=8787 \
PAWS_TLS_KEY_PATH=/etc/paws/tls.key \
PAWS_TLS_CERT_PATH=/etc/paws/tls.crt \
LINEAR_ORGANIZATION_ID=your-linear-organization-id \
bun run paws
```

### Behind a proxy

When a proxy in front of Paws terminates HTTPS, such as a Render web service, set `PAWS_PUBLIC_TLS=proxy` and leave out `PAWS_TLS_KEY_PATH` and `PAWS_TLS_CERT_PATH`. `PAWS_PUBLIC_URL` stays the `https:` origin the browser sees. Paws loads no certificate and serves plain HTTP on `PAWS_HOST`:`PAWS_PORT`. It treats each request as arriving on that HTTPS origin and keys the sign-in limits on the last `X-Forwarded-For` entry, which the proxy appends, falling back to the socket peer when the header is missing. Proxy mode trusts that the proxy is the only route to `PAWS_PORT` and that the last `X-Forwarded-For` entry is the client; anything that reaches the port directly can choose its own address. `paws public-tls validate` has no certificate to check. Runner control (`PAWS_RUNNER_HOST`) needs its own certificate and is not available in proxy mode yet.

Open the dashboard and select **Sign in with Linear**. A Linear workspace admin completes the personal sign-in and approves installing Paws into that same workspace. Paws rechecks their admin membership through the new app authorization, stores encrypted credentials, creates the workspace with that person as its first Paws admin, and starts the connected service automatically. The admin continues to **Integrations** to connect GitHub and map repositories to Linear teams. Once the GitHub App is installed, a Paws admin connects GitHub and adds any repository the installation covers and their GitHub account can read; after that, a Paws admin changes repositories without signing in to GitHub ([GitHub App](github-app.md#integrations)). Installing the App on an organization is done on GitHub by an organization owner.

If Linear revokes the app authorization, the dashboard offers **Reconnect Linear**. A workspace admin signs in and authorizes the same installation again. Paws preserves the workspace and its roles. The stored workspace binds reconnection to its organization. If `LINEAR_ORGANIZATION_ID` is set, it must match that stored organization.

Subsequent members use **Sign in with Linear** to open the workspace. A connected instance verifies each user's current membership against its installed Linear workspace.

Paws has two workspace roles: `admin` and `member`. Admins assign roles on Settings > Members lists workspace members and lets administrators filter active or revoked access, change roles, revoke access and restore it. Before revoking someone, review the confirmation naming the runners and work it will stop. Changes appear in Settings > Audit history.

You cannot revoke yourself or remove the last active administrator. Restoring a member does not restore their runners; they must pair them again. Ask an administrator to change members or roles.

## Admission

There is one admission mode: automatic. No admin approves a new member. When a person signs in with Linear, Paws reads their current Linear membership and creates their Paws membership as `member`; a Linear workspace admin becomes `admin`. A role an admin set by hand survives later syncs.

Who may delegate an issue to Paws is decided when the delegation arrives, with the person's live Linear membership. Each refusal ends the session with an error that starts "Paws did not start this work.":

| Delegator                           | Reason in the error                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Inactive Linear account             | Your Linear account is not active.                                        |
| Linear guest                        | Linear guests can't use Paws.                                             |
| Not in the issue's Linear team      | You are not a member of this issue's Linear team.                         |
| Inactive Paws membership            | Your Paws workspace membership is not active.                             |
| Active team member, never signed in | No error. Paws holds the delegation and posts one sign-in action (below). |

## A first delegation

A Linear member who has never signed in to Paws can delegate an issue anyway. Paws holds the delegation instead of refusing it, and the same Linear session carries the person through setup. What the session shows is in [Linear agent sessions](linear-agent-sessions.md).

1. The delegator presses **Sign in to Paws** in the session. It opens `/onboard/<link id>`, which starts Linear sign-in.
2. After sign-in, Paws creates the membership as in [Admission](#admission), releases the hold, and redirects to `/onboard/<link id>`, now the onboarding page.
3. The onboarding page lists the steps in order. Each step is a database fact; the page re-reads itself every 15 seconds (every 3 seconds while a VM is being set up) and never reads Linear.

| Step             | Done when                                                        | Otherwise                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear           | Always, once signed in: "Signed in as <email>."                  | —                                                                                                                                                                                                                                                                                                                                                             |
| Membership       | Active member of the issue's team: "Member of <team>."           | A Linear guest is refused. Someone outside the team is asked to have a team admin add them.                                                                                                                                                                                                                                                                   |
| Runner           | The member's own eligible runner: "<runner> will run this task." | **Create VM** (when Paws can create one and the member has no VM) and **Add a host**. Create VM shows its four steps (Create the VM, Install the runner, Enroll with Paws, First heartbeat); a failed setup offers **Retry**. Add a host asks for a host name and shows a one-time enrollment command. An offline or paused runner is named, with what to do. |
| Claude and Codex | The member's own account is signed in on their runner            | **Sign in on <runner>**, which opens the runner on the Runners page. Before a runner exists, the step reads "After the runner".                                                                                                                                                                                                                               |
| GitHub credit    | Linked: "Commits will credit @<login>."                          | Optional. A consent box and **Link GitHub**; GitHub returns the member to this page. Skipping it is fine: the commits are by the Paws App only.                                                                                                                                                                                                               |

The heading reads "Welcome, <first name>" and the lead line counts the remaining steps ("2 more steps before Paws starts PAS-n."). Once nothing is missing it reads "You're set up. Paws runs PAS-n on <runner>." The member can close the tab: Paws starts the task by itself once the runner and its agents are ready (see [Automatic start](#automatic-start)).

Onboarding counts only the delegator's own runner and agent accounts they signed in themselves. A lead's shared runner still runs the delegation's work, but it doesn't complete a member's onboarding. Only the owner of a runner can sign its agents in or share it. Linear guests never reach this page. How Create VM works is in [Create a VM](create-vm.md); Add a host is [Enroll a remote Linux runner](runner-enrollment.md); the credit link is in [GitHub App](github-app.md#credit-link).

### Automatic start

The resume never waits on a clock. A runner heartbeat, an agent sign-in becoming ready, a runner being shared, or a member VM reaching `ready` queues one `runner_setup.check` for the delegator, which reads the database only. If an eligible runner now has the agent ready, the item leaves its hold and the scheduler places it by the normal checks.

### Repository access

Repository access comes from the Linear team to repository mapping in Integrations. A team with mappings uses only those repositories; a team without any may use any repository in the catalog. A delegation Paws cannot place ends with one response that says why, instead of "Cancelled from Linear.":

- "<team> has no repository in Paws yet. Ask <admins> to map one in Integrations, then delegate again."
- "<owner/repo> isn't mapped to <team> in Paws."
- "You're not a member of <team> in Paws."
