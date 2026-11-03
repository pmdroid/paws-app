# Security considerations

Paws runs coding agents on input it doesn't control: Linear issues, repository files and third-party dependencies. Any of them can try to steer the agent. This page covers the GitHub settings that keep a steered agent away from the runner release key, and what giving runner work Docker access costs.

## The runner release key

`PAWS_RUNNER_RELEASE_KEY` signs every runner release. The `runner release` workflow (`.github/workflows/runner-release.yml`) signs `manifest.json` with it, and `deploy/linux/install-runner.sh` installs a release only if its signature matches `deploy/linux/release.pub`. Anyone holding the key can publish a runner package that every enrolled runner installs.

The key lives only in the `runner-release` environment, never as a repository secret:

- A repository secret is readable by every workflow run in the repository, including runs triggered by a push to any branch.
- An environment secret is readable only by jobs that name the environment, and only for the refs the environment allows.

The `build` job in `runner-release.yml` declares `environment: runner-release`. It runs on a published release, so its ref is the release tag.

### Set up the environment

1. Open **Settings > Environments > New environment** and name it `runner-release`.
2. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag rule `v*`. Add no branch rules.
3. Optionally, add yourself under **Required reviewers**. Each release then waits for your approval before it can read the key.
4. Add `PAWS_RUNNER_RELEASE_KEY` as an environment secret.
5. Delete `PAWS_RUNNER_RELEASE_KEY` from **Settings > Secrets and variables > Actions > Repository secrets**.

Check the result:

```sh
gh api repos/OWNER/REPO/actions/secrets --jq '.secrets[].name'
gh api repos/OWNER/REPO/environments/runner-release --jq '.deployment_branch_policy'
gh api repos/OWNER/REPO/environments/runner-release/deployment-branch-policies --jq '.branch_policies[] | "\(.type) \(.name)"'
gh api repos/OWNER/REPO/environments/runner-release/secrets --jq '.secrets[].name'
```

The first command should not list `PAWS_RUNNER_RELEASE_KEY`. The second should show `custom_branch_policies: true`. The third should list only `tag v*`, and the fourth should list `PAWS_RUNNER_RELEASE_KEY`.

## The GitHub App's Workflows permission

The Paws GitHub App needs **Workflows: Read and write** to push changes under `.github/workflows/`. Without it, GitHub refuses the whole push (`refusing to allow a GitHub App to create or update workflow … without workflows permission`), and the task stops with a question in Linear.

A workflow pushed to a branch runs straight away on `push` and `pull_request`, before anyone reviews or merges it. It can read every secret its job is allowed to read. So grant this permission only after the release key is in the `runner-release` environment and no longer a repository secret. A steered agent can then change CI on its branch, but its workflow runs can't reach the key.

Follow the same rule for every secret added later: put it in an environment limited to the refs that need it, never in repository secrets.

## Order

1. Move `PAWS_RUNNER_RELEASE_KEY` into the `runner-release` environment and delete the repository secret.
2. Merge the workflow change that sets `environment: runner-release` on the release job.
3. Grant the GitHub App **Workflows: Read and write**, and accept the new permission on the installation under **Settings > Applications > Installed GitHub Apps**.

## Docker access for runner work

Agent jobs get Docker only from a [rootless Docker](https://docs.docker.com/engine/security/rootless/) daemon that runs as `paws-agent` ([Docker access for runner work](runner-enrollment.md#docker-access-for-runner-work)). The daemon and its containers run inside a user namespace: root in a container is `paws-agent` on the host, and other container users map to `paws-agent`'s subordinate ids. A steered agent can do in a container what `paws-agent` can already do on the host, and no more. `paws-agent` still can't use the root daemon at `/var/run/docker.sock`. The package never adds a runner account to the `docker` group, whose members can act as root on the host.

Known limits of this setup:

- Containers get no CPU or memory limits. `paws-agent` has no systemd user session, so the daemon uses the cgroupfs driver without a delegated cgroup, and `docker info` reports `CgroupDriver=none`.
- Networking goes through slirp4netns, so containers can't bind host ports below 1024.
- One daemon serves every agent job on the runner. Jobs can see and change each other's images, containers and volumes.

An earlier release added `paws-runner` to the `docker` group on opt-in. An upgrade removes that membership only where the install state records that Paws added it; any other membership is left alone with a warning, because the install can't tell who added it. Identity checks on installs and upgrades accept that one membership and still reject any other supplemental group.
