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

Members of the `docker` group control the Docker daemon, which runs as root. [Docker's documentation](https://docs.docker.com/engine/install/linux-postinstall/) says the group grants root-level privileges. When you add `paws-runner` to it ([Docker access for runner work](runner-enrollment.md#docker-access-for-runner-work)), every agent and check the runner executes can act as root on the host. A steered agent can mount the host filesystem into a container. The `paws-runner.service` hardening (`NoNewPrivileges`, an empty capability set, `ProtectSystem`) does not contain Docker-enabled work, because the daemon does the privileged work outside the service.

Grant it only on a host you would let the agent's input control: a dedicated VM that holds no other secrets. The installer adds only `paws-runner`, never `paws-agent`, and only to an existing `docker` group that no other group name or Paws group shares. Identity checks on later installs and upgrades accept that one membership and still reject any other supplemental group. [Rootless Docker](https://docs.docker.com/engine/security/rootless/) uses a different access model, and the installer leaves it alone.
