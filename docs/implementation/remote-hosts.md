# Remote Linux hosts

A remote host runs a small Paws daemon and the agent software installed for its Linux accounts. The daemon connects outward to the Paws control plane. Pairing gives the host a workspace identity; agent login gives a local agent access to its provider account.

## Install a signed release

The release and installer modules in `deploy/linux` define a signed Linux package, its manifest, and the host installation contract. The release verifier checks the Ed25519 manifest signature, artifact SHA-256, host platform, pinned Bun version, and archive members. The installer validates the package before selecting a release. It deploys the declared service assets and provider launchers and manages the release pointer used by those launchers.

Installer verification exercises interruption during release selection and recovery. The provider bootstrap adds fixed launchers for the agent programs, so operator commands and service execution resolve the same selected release.

See the [signed Linux release](https://github.com/pmdroid/paws-app/pull/237), [validated installer](https://github.com/pmdroid/paws-app/pull/244), and [provider bootstrap](https://github.com/pmdroid/paws-app/pull/245). The [installation contract](https://github.com/pmdroid/paws-planning/issues/12) owns host prerequisites and packaging.

## Keep process identities separate

The host installation contract uses distinct non-root `paws-runner`, `paws-agent`, and `paws-check` accounts. The daemon owns the runner transport and protected state. The agent uses its own home directory and provider login state. The execution broker and spool define the controlled exchange of jobs, events, and results between those roles.

| Path                                  | Owner                     | Mode   | Purpose                                   |
| ------------------------------------- | ------------------------- | ------ | ----------------------------------------- |
| `/opt/paws-runner/releases/{version}` | `root`                    | `0755` | Versioned application and runtime assets. |
| `/var/lib/paws-runner-install`        | `root`                    | `0700` | Installation lock and release state.      |
| `/var/lib/paws-runner`                | `paws-runner:paws-runner` | `0700` | Runner home and private state.            |
| `/var/lib/paws-agent`                 | `paws-agent:paws-agent`   | `0700` | Agent home and provider login.            |
| `/var/lib/paws-check`                 | `paws-check:paws-check`   | `0700` | Check account home.                       |
| `/var/lib/paws-runner-spool`          | `paws-runner:paws-agent`  | `2750` | Job delivery.                             |
| `/var/lib/paws-agent-results`         | `root:paws-results`       | `0750` | Agent result root.                        |

The operator performs provider login in the agent's identity and home. A health or login check reports whether that local agent can authenticate. Provider credentials stay with the agent account on the host.

After installation, the installer returns these operator login commands. Run them with root privileges on the host:

```sh
/usr/sbin/runuser --user paws-agent -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/claude auth login
/usr/sbin/runuser --user paws-agent -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/codex login --device-auth
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
