# GitHub sign-in

Paws supports GitHub App browser sign-in with repository work performed by the App bot, and OAuth App device sign-in with work performed as your account. Linear intake and questions are described in [Linear modes](linear-modes.md).

## GitHub App sign-in

Create a GitHub App under **Settings > Developer settings > GitHub Apps**. Set its callback URL to `http://127.0.0.1:3000/oauth/github/callback`. This listener runs during sign-in; the Paws dashboard uses port `8787`.

Grant repository **Contents**, **Pull requests**, **Checks**, and **Issues** permissions with **Read and write** access. GitHub grants **Metadata** read access automatically. Set the webhook URL to your HTTPS tunnel followed by `/webhooks/github`, choose a webhook secret, and set `GITHUB_WEBHOOK_SECRET` before sign-in. Subscribe to **Pull requests**, **Check runs**, **Check suites**, **Pushes**, **Installations** and **Installation repositories**. Signed deliveries are stored durably and deduplicated by delivery ID. Install the App on the repositories Paws will work on.

Generate a client secret and a private key. Set `GITHUB_APP_ID`, `PAWS_GITHUB_CLIENT_ID`, `PAWS_GITHUB_CLIENT_SECRET`, and `GITHUB_APP_PRIVATE_KEY_PATH` in your local environment, then run:

```sh
bun run paws login github --app --repo owner/name
bun run paws setup --repo owner/name
```

Paws opens the App's authorization page. After you approve it, Paws checks your repository access, discovers the installation, and verifies that it can mint a token restricted to that repository. It sets `github.auth = "app"` and preserves the rest of your config. [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) uses the App's permissions rather than OAuth App scopes.

The private key and App credentials are envelope-encrypted and saved as `~/.paws/secrets/github-app.pem` and `github-app.json`, both mode `0600`, inside the mode `0700` secrets directory. Subsequent starts load these files. Environment variables override saved credentials. Your sign-in token uses the token store described below. Repository operations mint installation tokens and appear as `<app-slug>[bot]`.

With App mode configured, the dashboard's **Sign in with GitHub** button provides a **Continue with GitHub** authorization link. Setup preserves App mode when connecting Linear.

## OAuth App device sign-in

```sh
bun run paws login github
```

Paws prints a one-time code and tells you to approve it at [github.com/login/device](https://github.com/login/device). It polls GitHub's token endpoint on the interval GitHub returns, until you approve the code or GitHub expires it.

`bun run paws setup` runs this sign-in while it writes `~/.paws/config.toml`. When a token is already stored, setup goes on to the repository question.

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

Setup writes `auth = "oauth"` after the device flow succeeds and preserves `auth = "app"` after GitHub App sign-in.

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
