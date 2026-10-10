# GitHub sign-in

Paws signs in as you with the [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow). The terminal and the dashboard on `127.0.0.1` start the same flow. Issue polling, triggers, and comments are in [GitHub issues](github-issues.md).

## Sign in

```sh
bun run paws login github
```

Paws prints a one-time code and tells you to approve it at [github.com/login/device](https://github.com/login/device). It polls GitHub's token endpoint on the interval GitHub returns, until you approve the code or GitHub expires it.

`bun run paws setup` runs this sign-in while it writes `~/.paws/config.toml`. When a token is already stored, setup goes on to the repository question.

The dashboard at `http://127.0.0.1:8787` has a **Sign in with GitHub** button. The button starts this device flow in the local process and shows the same code and device page.

## Scopes

The request asks for `repo` and `read:org`.

- `repo` covers issues, contents, pull requests, and merges on the repositories you grant.
- `read:org` covers organization membership. [GitHub issues](github-issues.md) uses that membership for the `MEMBER` trust rule.

The `workflow` scope stays off the request. GitHub then rejects a push that changes files under `.github/workflows`. An implementer working with this token cannot edit Actions workflows. Scope names are GitHub's: [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

## Where the token lives

| Host | Store |
| ---- | ----- |
| macOS | Keychain |
| Linux | libsecret (Secret Service) |
| Either, when that store is unavailable | `~/.paws/secrets/github-oauth.json`, mode `0600` |

`~/.paws/secrets/` is mode `0700`. The JSON file holds the access token and the GitHub login it belongs to. `github.oauth_client_id` stays in `config.toml`. The token stays out of `config.toml`.

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

| Key | Values |
| --- | ------ |
| `auth` | `oauth` (this device flow), `gh` (the `gh` CLI login), or `app` (a GitHub App installation) |
| `oauth_client_id` | Client id of the OAuth App. Required when `auth` is `oauth`. |
| `repo` | `owner/name` Paws pushes to and opens pull requests against |

Setup writes `auth = "oauth"` after the device flow succeeds.

`github.auth = "gh"` takes a fresh `gh auth token` for each operation. Log in with `gh auth login` first. Paws does not copy that token into `~/.paws/secrets`.

`github.auth = "app"` mints a GitHub App installation token. That is the optional path that can act as its own bot user. The default tracker in [GitHub issues](github-issues.md) does its work with the user token from this page.

## Create an OAuth App

The smoke run uses Pascal's OAuth App. To register your own: GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**. See [Creating an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

1. Application name: `Paws (local)`.
2. Homepage URL: `https://github.com/pmdroid/paws-app`.
3. Authorization callback URL: `http://127.0.0.1/`. The device flow leaves this URL unused. GitHub's form still requires a callback.
4. Register the application, then open it and check **Enable Device Flow**.
5. Paws uses no client secret. If GitHub displays a client secret after registration, leave it there. Copy only the client id into `github.oauth_client_id`.

When an organization limits third-party applications, an owner approves **Paws (local)** under **Third-party access**. Until that approval, the token can reach your personal repositories and cannot reach the organization's private issues. GitHub documents the owner step in [Approving OAuth apps for your organization](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/approving-oauth-apps-for-your-organization).
