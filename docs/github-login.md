# GitHub sign-in

Paws supports GitHub App browser sign-in with repository work performed by the App bot, and OAuth App device sign-in with work performed as your account. Linear intake and questions are described in [Linear agent sessions](linear-agent-sessions.md).

## GitHub App sign-in

Create a GitHub App under **Settings > Developer settings > GitHub Apps**. Register `https://YOUR-PAWS-HOST/auth/github-app/callback` for Integrations and `https://YOUR-PAWS-HOST/auth/github-attribution/callback` for account attribution, using your configured Paws HTTPS origin.

Grant repository **Contents**, **Pull requests**, **Checks**, **Issues**, and **Workflows** permissions with **Read and write** access, and **Commit statuses** and **Merge queues** with **Read-only** access. GitHub grants **Metadata** read access automatically. Grant **Workflows** only after the release key is set up as described in [Security considerations](security-considerations.md). Under **Webhook**, check **Active**, set the URL to your HTTPS tunnel followed by `/webhooks/github`, choose a webhook secret, and set `GITHUB_WEBHOOK_SECRET` (or `~/.paws/secrets/github-webhook`) before sign-in. Subscribe to **Check runs**, **Check suites**, **Statuses**, **Pull requests**, **Pull request reviews**, **Merge groups**, **Pushes**, **Installations** and **Installation repositories**. Install the App on the repositories Paws will work on.

Signed deliveries are stored durably and deduplicated by delivery ID. A delivery for a task's pull request, branch or head commit wakes its merge at once, so CI results, reviews and GitHub merge queue changes are picked up without polling. While deliveries arrive, a waiting merge reads GitHub only every 5 minutes as a backstop. After an hour without a delivery it reads every 10 to 30 seconds again. `bun run paws doctor` reports the last delivery as `github-webhook`, and **Settings > Integrations** shows it on the GitHub line.

Generate a client secret and a private key. Set `GITHUB_APP_ID`, `PAWS_GITHUB_CLIENT_ID`, `PAWS_GITHUB_CLIENT_SECRET`, and `GITHUB_APP_PRIVATE_KEY_PATH` on the Paws server. Set `GITHUB_AUTH=app`, start Paws, sign in with Linear and open **Integrations**. Select **Continue with GitHub**, choose repositories, and map them to Linear teams.

For the standalone terminal login, also register `http://127.0.0.1:3000/oauth/github/callback`, then run:

```sh
bun run paws login github --app --repo owner/name
```

Paws opens the App's authorization page. After you approve it, Paws checks your repository access, discovers the installation, and verifies that it can mint a token restricted to that repository. It sets `github.auth = "app"` and preserves the rest of your config. [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) uses the App's permissions rather than OAuth App scopes.

The private key and App credentials are envelope-encrypted and saved as `~/.paws/secrets/github-app.pem` and `github-app.json`, both mode `0600`, inside the mode `0700` secrets directory. Subsequent starts load these files. Environment variables override saved credentials. Your sign-in token uses the token store described below. Repository operations mint installation tokens and appear as `<app-slug>[bot]`.

With App mode configured, the dashboard's **Sign in with GitHub** button provides a **Continue with GitHub** authorization link. The browser onboarding flow uses the configured GitHub App.

## Commit credit

Every commit is authored and committed by the App bot. To be credited, a member chooses **Link GitHub identity** once under **Settings > Account** and consents to the link. When that member delegates an issue, each commit of the run carries one `Co-authored-by: <name> <id+login@users.noreply.github.com>` trailer with their GitHub noreply address, and the pull request body credits their GitHub login. Paws reads the stored link at run start and makes no Linear or GitHub request for it. A member who has not linked, or who revoked the link, gets no trailer, and the run starts without waiting. The runner refuses a candidate whose new commits are not authored by the App bot or whose trailers differ from the run's credit.

## OAuth App device sign-in

```sh
bun run paws login github
```

Paws prints a one-time code and tells you to approve it at [github.com/login/device](https://github.com/login/device). It polls GitHub's token endpoint on the interval GitHub returns, until you approve the code or GitHub expires it.

Workspace owners connect GitHub and choose repositories through Integrations after signing in with Linear.

The dashboard at `http://127.0.0.1:8787` has a **Sign in with GitHub** button. The button starts this device flow in the local process and shows the same code and device page.

## Scopes

The request asks for `repo` and `read:org`.

- `repo` covers issues, contents, pull requests, and merges on the repositories you grant.
- `read:org` covers organization membership.

The `workflow` scope stays off the request. GitHub then rejects a push that changes files under `.github/workflows`. An implementer working with this token cannot edit Actions workflows. Scope names are GitHub's: [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

## Where the token lives

| Host                                   | Store                                            |
| -------------------------------------- | ------------------------------------------------ |
| macOS                                  | Keychain                                         |
| Linux                                  | libsecret (Secret Service)                       |
| Either, when that store is unavailable | `~/.paws/secrets/github-oauth.json`, mode `0600` |

`~/.paws/secrets/` is mode `0700`. The file holds an envelope-encrypted access token and the GitHub login it belongs to. Its key-encryption key is `~/.paws/secrets/.envelope-key`, outside the database. `github.oauth_client_id` stays in `config.toml`. The token stays out of `config.toml`.

Paws does not write the token to logs or to `paws doctor` output.

Sign out with either of these:

```sh
bun run paws logout
paws logout
```

Logout deletes the token from Keychain, libsecret, and `github-oauth.json`.

## How each operation gets the token

Every push, pull request, and merge fetches the token for that operation and passes it through a one-shot git credential helper. The helper file does not contain the token. The remote stays `https://github.com/<owner>/<repo>.git`, with no userinfo and no token in the query string. The token is not a command-line argument.

The helper's environment exists only for that git command. The ACP agent environment does not receive the token, and agent command lines do not either. `gh` mode and GitHub App mode follow the same rule.

## Config

```toml
[github]
auth = "oauth"
oauth_client_id = "<client id>"
repo = "owner/name"
```

| Key               | Values                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `auth`            | `oauth` (this device flow), `gh` (the `gh` CLI login), or `app` (a GitHub App installation) |
| `oauth_client_id` | Client id of the GitHub App or OAuth App.                                                   |
| `repo`            | `owner/name` Paws pushes to and opens pull requests against                                 |

GitHub App sign-in writes `auth = "app"` and preserves the other configuration.

`github.auth = "gh"` takes a fresh `gh auth token` for each operation. Log in with `gh auth login` first. Paws does not copy that token into `~/.paws/secrets`.

`github.auth = "app"` mints a GitHub App installation token. That is the optional path that can act as its own bot user.

## Create an OAuth App

The smoke run uses Pascal's OAuth App. To register your own: GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**. See [Creating an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

1. Application name: `Paws (local)`.
2. Homepage URL: `https://github.com/pmdroid/paws-app`.
3. Authorization callback URL: `http://127.0.0.1/`. The device flow leaves this URL unused. GitHub's form still requires a callback.
4. Register the application, then open it and check **Enable Device Flow**.
5. Paws uses no client secret. If GitHub displays a client secret after registration, leave it there. Copy only the client id into `github.oauth_client_id`.

When an organization limits third-party applications, an owner approves **Paws (local)** under **Third-party access**. Until that approval, the token can reach your personal repositories and cannot reach the organization's private issues. GitHub documents the owner step in [Approving OAuth apps for your organization](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/approving-oauth-apps-for-your-organization).

## Workspace repository setup

Open Settings → Integrations and choose **Sign in with GitHub**. Authorize the Paws GitHub App. If the App needs repository access, choose **Choose repositories on GitHub**, select its repositories on GitHub, then return to Paws and refresh the list.

Choose the GitHub account, find your repositories, and check the Linear teams that can use each one. A repository can match several teams. Choose **Save repository access**. Workspace access links back to this picker.

Paws keeps App credentials and temporary authorization tokens on the server. Repository work uses scoped App installation tokens.
