# Security and runner access

Paws runs coding agents on issue descriptions, repository files and dependencies. Treat that work as untrusted when choosing a runner and granting repository access.

## Repository access

Use a [GitHub App](github-app.md) with access to the repositories Paws needs. Map repositories to the appropriate Linear teams in Integrations. Review workspace membership and roles through [Workspace access](workspace-access.md).

Keep credentials in Paws' configured secret storage. Follow [Database setup](postgres.md#secrets) when using an external database, and keep its master key available after restarts.

## Runner accounts and Docker

Use the separate `paws-agent` account described in [runner enrollment](runner-enrollment.md). Keep the runner's identity keys and personal credentials out of agent workspaces.

When enabling Docker for agent work, use the rootless daemon provided for the agent account. A container can access files that account can read or write. Consider the repositories and credentials available to the account before enabling it.

Review runner access when a member leaves or a host is retired. Use the Runners page to manage enrolled hosts and their agent sign-ins.

## Release and package publishing

The release workflow builds the runner and control-plane Debian packages for amd64 and arm64 without repository secrets or a GitHub environment. It records SHA-256 checksums and creates GitHub build provenance for each package. The packages and Sigstore bundles pass to publishing through workflow artifacts. Apt verifies the signed repository metadata and package hashes. Runner packages retain a manifest for version, platform and payload digest checks; they require no separate manifest signature.

Before publishing, the protected `release` environment job checks that the tag's commit is on `main` and its latest main push `ci` run succeeded. It checks each package's SHA-256 and verifies its attestation against this repository's release workflow before adding packages to apt. The GitHub release also carries `.deb` and `.sha256` assets for manual downloads.

The apt signing subkey belongs in the `release` environment. Keep the primary key offline. Repository metadata includes a 90-day `Valid-Until`; renew it before expiry with the workflow's `resign_only` input. To exercise builds and attestation verification without publishing, dispatch the workflow at a `v*` tag with `dry_run` enabled.

Verify a downloaded package with:

```sh
gh attestation verify <file>.deb --repo pmdroid/paws-app
```

Configure the `release` environment to accept only `v*` tags and require Pascal's review. Restrict creation of `v*` tags to maintainers through a tag ruleset, and forbid updating or deleting them.
