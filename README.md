# Paws

Paws picks up issues you delegate in Linear, runs coding agents on paired Linux runners, checks their work with Closeout, and opens or merges pull requests on GitHub.

## Set up Paws

Install Bun 1.4.4 or newer and Git, clone this repository, then install dependencies and build the dashboard:

```sh
bun install
bun run build:dashboard
```

Configure [workspace access](docs/workspace-access.md) and a [GitHub App](docs/github-app.md), then start Paws:

```sh
bun run paws
```

Open your configured HTTPS address. A Linear workspace administrator signs in and authorizes Paws. In Integrations, connect GitHub and choose repositories and their Linear teams. [Enroll a Linux runner](docs/runner-enrollment.md), or [create a runner VM](docs/create-vm.md), then sign in to its coding agents through Runners.

Run `bun run paws doctor` to check setup. Paws starts work after the Linear workspace is configured.

## Delegate work

Delegate an issue to the Paws app in Linear. Follow progress in the issue's agent session or the Paws dashboard. When Paws asks a question, reply in Linear or the dashboard. Delegate a parent issue to run its sub-issues in dependency order.

- [Choose a repository](docs/repository-selection.md).
- [Follow sessions and answer questions](docs/linear-agent-sessions.md).
- [Review checks and evidence](docs/closeout.md).
- [Review improvements](docs/improvement-review.md).
- [Declare your repository's runtimes](docs/runtimes.md).
- [Add local implementation skills](docs/local-skills.md).
- [Set a local Closeout policy](docs/local-closeout.md).

## Manage your installation

- [Configuration reference](docs/configuration.md).
- [Database setup](docs/postgres.md).
- [Moving from an earlier SQLite installation](docs/database-reset.md).
- [Security and runner access](docs/security-considerations.md).
- [Release notes](CHANGELOG.md).

Paws can restart while work is running. Runners retain their results until it returns. To deploy a new commit, update the installed checkout and restart the service:

```sh
cd ~/.local/share/paws/app
git fetch && git checkout <commit>
bun install --frozen-lockfile
bun run build:dashboard
systemctl --user restart paws.service
```

The dashboard shows issues, runs, questions, evidence, runners and settings. Use it to answer questions, manage access and follow pull requests through verification and merging.
