# GitHub App

Paws reaches GitHub through one credential: a GitHub App. Every clone, push, pull request and merge uses a short-lived installation token, and commits are authored by the App bot, `<app-slug>[bot]`. No member signs in to GitHub for repository access. A member reaches a repository when Integrations maps it to a Linear team they work in. Linear intake and questions are described in [Linear agent sessions](linear-agent-sessions.md).

## Create the App

Create a GitHub App under **Settings > Developer settings > GitHub Apps**. Register two callback URLs on your configured Paws HTTPS origin:

- `https://YOUR-PAWS-HOST/auth/github-app/callback` for Integrations.
- `https://YOUR-PAWS-HOST/auth/github-attribution/callback` for the credit link.

Grant repository **Contents**, **Pull requests**, **Checks**, **Issues**, and **Workflows** permissions with **Read and write** access, and **Commit statuses** and **Merge queues** with **Read-only** access. GitHub grants **Metadata** read access automatically. Grant **Workflows** only after the release key is set up as described in [Security considerations](security-considerations.md). Push tokens ask for **Workflows** write; an installation without it gets a token without it after one refused request, and pushes that change `.github/workflows` fail. `paws doctor` reports which applies on the `github-app-installation` line.

Under **Webhook**, check **Active** and set the URL to your HTTPS origin followed by `/webhooks/github`. Choose a webhook secret and set `GITHUB_WEBHOOK_SECRET`, or save it as `~/.paws/secrets/github-webhook`. Subscribe to **Check runs**, **Check suites**, **Statuses**, **Pull requests**, **Pull request reviews**, **Pull request review comments**, **Issue comments**, **Merge groups**, **Pushes**, **Installations** and **Installation repositories**.

Generate a client secret and a private key. Install the App on the repositories Paws will work on.

## Configure Paws

Set these on the Paws server:

| Variable                      | Value                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| `GITHUB_APP_ID`               | The App ID.                                                 |
| `PAWS_GITHUB_CLIENT_ID`       | The App client ID.                                          |
| `PAWS_GITHUB_CLIENT_SECRET`   | The App client secret.                                      |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to the private key, mode `0600`.                       |
| `GITHUB_APP_INSTALLATION_ID`  | Optional. Integrations finds the installation when omitted. |

Paws can also read these from `~/.paws/secrets/github-app.json` and `github-app.pem`. Both files are envelope-encrypted, mode `0600`, inside the mode `0700` secrets directory. Environment variables override the saved files.

`config.toml` needs no GitHub credential. `github.auth` is optional, and the only accepted value is `app`:

```toml
[github]
auth = "app"
repo = "owner/name"
```

A config that still sets `auth = "oauth"` or `auth = "gh"`, or a `GITHUB_AUTH` with either value, stops Paws at startup with a message that points here. Remove the line or set it to `app`. `oauth_client_id` is no longer read. Delete it from `config.toml`.

## Integrations

Start Paws, sign in with Linear as a workspace owner, and open **Settings > Integrations**.

1. Select **Continue with GitHub** and authorize the App.
2. If the App needs repository access, choose **Choose repositories on GitHub**, select the repositories on GitHub, then return to Paws and refresh the list.
3. Check the Linear teams that can use each repository. A repository can match several teams.
4. Choose **Save repository access**.

Paws keeps App credentials and temporary authorization tokens on the server. Workspace access links back to this picker.

## Check the setup

```sh
bun run paws doctor
```

Doctor reports these GitHub checks:

| Check                     | Passes when                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `github-app`              | The App ID and a private key at mode `0600` or `0400` are configured.       |
| `github-app-installation` | The App is installed on `github.repo` and the installation is active.       |
| `github-app-push`         | Paws can mint a write token for that repository with the App's grants.      |
| `github-rate`             | The installation has at least 100 core REST calls left.                     |
| `github-app-events`       | The App subscribes to every webhook event Paws acts on, including comments. |
| `github-webhook`          | A signed GitHub webhook delivery has arrived. Shown once one is expected.   |

Each failing check prints one fix.

## Credit link

Every commit is authored and committed by the App bot. To be credited, a member links a GitHub identity once in **Settings > Account > GitHub credit**:

1. Check the consent box for public commit and pull request credit.
2. Select **Link GitHub identity** and approve the App on GitHub.

When that member delegates an issue, each commit of the run carries one `Co-authored-by: <name> <id+login@users.noreply.github.com>` trailer with their GitHub noreply address, and the pull request body credits their GitHub login. Paws reads the stored link at run start and makes no Linear or GitHub request for it. A member who has not linked, or who revoked the link with **Revoke attribution consent**, gets no trailer, and the run starts without waiting. The runner refuses a candidate whose new commits are not authored by the App bot or whose trailers differ from the run's credit.

## Webhook deliveries

Signed deliveries are stored durably and deduplicated by delivery ID. A delivery for a task's pull request, branch or head commit wakes its merge at once, so CI results, reviews and merge queue changes are picked up without polling. While deliveries arrive, a waiting merge reads GitHub only every 5 minutes as a backstop. After an hour without a delivery it reads every 10 to 30 seconds again. **Settings > Integrations** shows the last delivery on the GitHub line.

## How each operation gets a token

Every push, pull request and merge mints an installation token restricted to that repository and passes it through a one-shot git credential helper. The helper file does not contain the token. The remote stays `https://github.com/<owner>/<repo>.git`, with no userinfo and no token in the query string. The token is not a command-line argument, and the ACP agent environment never receives it.
