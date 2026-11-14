# Security and runner access

Paws runs coding agents on issue descriptions, repository files and dependencies. Treat that work as untrusted when choosing a runner and granting repository access.

## Repository access

Use a [GitHub App](github-app.md) with access to the repositories Paws needs. Map repositories to the appropriate Linear teams in Integrations. Review workspace membership and roles through [Workspace access](workspace-access.md).

Keep credentials in Paws' configured secret storage. Follow [Database setup](postgres.md#secrets) when using an external database, and keep its master key available after restarts.

## Runner accounts and Docker

Use the separate `paws-agent` account described in [runner enrollment](runner-enrollment.md). Keep the runner's identity keys and personal credentials out of agent workspaces.

When enabling Docker for agent work, use the rootless daemon provided for the agent account. A container can access files that account can read or write. Consider the repositories and credentials available to the account before enabling it.

Review runner access when a member leaves or a host is retired. Use the Runners page to manage enrolled hosts and their agent sign-ins.
