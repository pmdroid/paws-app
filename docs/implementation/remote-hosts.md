# Remote Linux hosts

A remote host runs a small Paws daemon and the agent software installed for its Linux accounts. The daemon connects outward to the Paws control plane. Pairing gives the host a workspace identity; agent login gives a local agent access to its provider account.

Follow [Pair a remote Linux runner](../runner-pairing.md) for host configuration, provider login, fingerprint approval and service startup.

## Install a signed release

On the Linux host:

```sh
curl -fsSL https://get.paws.boo | sudo sh
```

The installer reads the host architecture, downloads the matching package from the latest GitHub release, checks the published SHA-256, and installs it with apt. Pass a version to install that release:

```sh
curl -fsSL https://get.paws.boo | sudo sh -s -- 1.2.3
```

Publishing a GitHub release tagged `vX.Y.Z` or `X.Y.Z` builds native AMD64 and ARM64 Debian packages named `paws-runner_X.Y.Z_amd64.deb` and `paws-runner_X.Y.Z_arm64.deb`, each with a `.deb.sha256` file. The package includes the compiled runner and the Bun runtime its agent programs use. The host needs systemd.

To verify and install a downloaded ARM64 package directly:

```sh
sha256sum --check paws-runner_X.Y.Z_arm64.deb.sha256
sudo apt install ./paws-runner_X.Y.Z_arm64.deb
```

The Debian package verifies its embedded signed manifest and runtime archive before installation. Reinstalling the same exact release preserves the verified runtime and host identity. Upgrades refuse active executions, preserve configuration and agent login data, and restart the services that were running before the upgrade. Aborted upgrades and removals restore the previously active services. Removal stops and disables the runner services and removes the runtime. Purging also removes `/etc/paws-runner/config.json`; pairing and agent login data remain in their service accounts' state directories.

The [release workflow](../../.github/workflows/runner-release.yml) builds on GitHub's native AMD64 and ARM64 runners when a release is published. It attaches both packages and their SHA-256 files after both builds succeed. The `PAWS_RUNNER_RELEASE_KEY` repository secret holds the Ed25519 private key matching `deploy/linux/release.pub`.

The release and installer modules in `deploy/linux` define a signed Linux package, its manifest, and the host installation contract. The release verifier checks the Ed25519 manifest signature, artifact SHA-256, host platform, pinned Bun version, and archive members. The installer validates the package before selecting a release. It deploys the declared service assets and provider launchers and manages the release pointer used by those launchers.

Installer verification exercises interruption during release selection and recovery. The provider bootstrap adds fixed launchers for the agent programs, so operator commands and service execution resolve the same selected release.

See the [signed Linux release](https://github.com/pmdroid/paws-app/pull/237), [validated installer](https://github.com/pmdroid/paws-app/pull/244), and [provider bootstrap](https://github.com/pmdroid/paws-app/pull/245). The [installation contract](https://github.com/pmdroid/paws-planning/issues/12) owns host prerequisites and packaging.

## Keep process identities separate

The host installation contract uses distinct non-root `paws-runner` and `paws-agent` accounts. The daemon runs agent work as `paws-runner`. Provider login state stays in `/var/lib/paws-agent`.

- `/opt/paws-runner/releases/{version}` contains versioned application and runtime assets. Owner `root`, mode `0755`.
- `/var/lib/paws-runner-install` holds the installation lock and release state. Owner `root`, mode `0700`.
- `/var/lib/paws-runner` is the runner home and private state directory. Owner `paws-runner:paws-runner`, mode `0700`.
- `/var/lib/paws-agent` is the agent home and provider login directory. Owner `paws-runner:paws-runner`, mode `0700`.
- `/var/lib/paws-runner-spool` delivers jobs. Owner `paws-runner:paws-agent`, mode `2750`.
- `/var/lib/paws-agent-results` is the agent result root. Owner `paws-runner:paws-results`, mode `0750`.

The operator performs provider login as `paws-runner`, with home `/var/lib/paws-agent`. A health or login check reports whether that local agent can authenticate. Provider credentials stay in `/var/lib/paws-agent`.

After installation, the installer returns these operator login commands. Run them with root privileges on the host:

```sh
/usr/sbin/runuser --user paws-runner -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/claude auth login
/usr/sbin/runuser --user paws-runner -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/codex login --device-auth
```

The provider bootstrap verifies the bundled launchers against real provider CLI help, version, and login-status commands. See [PR 245](https://github.com/pmdroid/paws-app/pull/245), the [execution broker](https://github.com/pmdroid/paws-app/blob/cd6753d9e7aecbd702aa75fd1b82bbd7dae57b6a/src/runner-execution/broker.ts), and the [work/spool integration](https://github.com/pmdroid/paws-app/pull/248).

## Fetch and refresh repositories

The repository helper consumes a validated work command that names the GitHub owner, repository, HTTPS remote URL, and exact base commit.

1. Serialize operations for that repository's private bare mirror.
2. Obtain the read credential for the command through the configured credential callback.
3. Clone into a temporary bare mirror on first use, then select it atomically. Fetch into the existing mirror on later work.
4. Resolve the assigned base commit and reject the assignment if that commit is unavailable.
5. Create a Git bundle for that commit, with a private file mode, for the worker's input.

Refreshing the mirror does not change the assigned base of an existing command. A new command carries the base commit for its own run. The mirror is a repository cache; the run's commit identity determines what the agent receives.

See [the repository helper](https://github.com/pmdroid/paws-app/blob/550e7b008353ccc99efa886fe27dbbafeacd1b65/src/runner-repositories/index.ts) and [repository binding verification](https://github.com/pmdroid/paws-app/pull/227).

## Return an exact candidate

The worker returns a candidate bundle, commit SHA, and Paws branch name. The repository helper verifies the bundle, checks that its commit matches the claimed SHA, and verifies that the assigned base is an ancestor. Publication obtains the command's write credential and pushes that exact commit to the validated Paws branch. A review command cannot publish a candidate through this helper.

The [repository access contract](https://github.com/pmdroid/paws-planning/issues/8) and [PR 227](https://github.com/pmdroid/paws-app/pull/227) describe the authorization and commit bindings.

## Report progress and health

The daemon uses the authorized runner protocol for work, heartbeats, events, results, and answers. The work service records the current lease and generation. The results service persists accepted submissions and question answers. The health ledger records the runner's reported health and exposes authorized reads for administration.

Health reports have a route-specific byte budget. Browser health-command requests have a 128 KiB budget; runner health submissions have a 1 MiB budget. The health implementation checks bounded request bodies and validates provider and model metadata. Its verification includes real mTLS requests, repeated submissions, and oversized-stream cancellation.

See [the daemon client](https://github.com/pmdroid/paws-app/pull/231), [work grants](https://github.com/pmdroid/paws-app/pull/235), [results and answers](https://github.com/pmdroid/paws-app/pull/247), and [health reports](https://github.com/pmdroid/paws-app/pull/249).
