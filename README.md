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

Workspace › Integrations lists the prerequisite checks under Prerequisites. Paws starts work after the Linear workspace is configured.

## Install the control plane from the package

Download the `paws-control-plane_<version>_amd64.deb` and matching `.deb.sha256` from the GitHub release. Use `arm64` on an ARM host. In the download directory, run:

```sh
sha256sum -c paws-control-plane_<version>_amd64.deb.sha256
sudo apt install ./paws-control-plane_<version>_amd64.deb
sudoedit /etc/paws/control-plane.env
sudo systemctl restart paws.service
```

The package enables and starts the service. Configure the public URL and TLS paths in the environment file before using it, then complete workspace access and GitHub App setup above. The service runs as `paws` with `PAWS_HOME=/var/lib/paws`. Upgrades preserve the environment file and stop the service before backing up local PGlite data, retaining the newest three copies in `/var/lib/paws/backups`. A configured `PAWS_DATABASE_URL` skips that copy.

On Fedora, RHEL, Rocky Linux or AlmaLinux, download `paws-control-plane-<version>-1.x86_64.rpm` and its `.rpm.sha256` instead. Use `aarch64` on an ARM host. In the download directory, run:

```sh
sha256sum -c paws-control-plane-<version>-1.x86_64.rpm.sha256
sudo dnf install ./paws-control-plane-<version>-1.x86_64.rpm
sudoedit /etc/paws/control-plane.env
sudo systemctl restart paws.service
```

To get updates through `dnf upgrade` instead, install from the [Paws dnf repository](#install-from-the-paws-package-repositories). The RPM installs the same files and service as the `.deb`, and upgrades the same way: `sudo dnf upgrade ./paws-control-plane-<version>-1.x86_64.rpm` keeps your environment file and backs up local PGlite data first. Removing the package keeps your edited environment file as `/etc/paws/control-plane.env.rpmsave`.

Each release package has a build provenance attestation. Check one with `gh attestation verify <package> --repo pmdroid/paws-app`.

The source installation above remains available.

## Delegate work

Delegate an issue to the Paws app in Linear. Follow progress in the issue's agent session or the Paws dashboard. When Paws asks a question, reply in Linear or the dashboard. Delegate a parent issue to run its sub-issues in dependency order.

- [Choose a repository](docs/repository-selection.md).
- [Follow sessions and answer questions](docs/linear-agent-sessions.md).
- [Review checks and evidence](docs/closeout.md).
- [Review improvements](docs/improvement-review.md).
- [Project context](docs/project-context.md).
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

## Install from the Paws package repositories

The one-line installer adds the signed repository and installs the control plane; add `--runner` to install a runner instead:

```sh
curl -fsSL https://get.paws.boo | sudo sh
curl -fsSL https://get.paws.boo | sudo sh -s -- --runner
```

On Debian and Ubuntu it uses apt. On Fedora, RHEL, Rocky Linux and AlmaLinux (hosts with `dnf` and without `apt-get`) it writes `/etc/yum.repos.d/paws.repo` and runs `dnf install paws-control-plane`, or `paws-control-plane-<version>` when you pass a version. There is no runner RPM, so `--runner` stops with an error on those hosts: install runners on Debian or Ubuntu.

Or set up the apt repository by hand:

```sh
curl -fsSL https://get.paws.boo/apt/paws.gpg | sudo tee /usr/share/keyrings/paws.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/paws.gpg] https://get.paws.boo/apt stable main" | sudo tee /etc/apt/sources.list.d/paws.list
sudo apt-get update && sudo apt-get install paws-runner
```

The repository serves `amd64` and `arm64` packages in `stable main`, retaining the newest 10 versions per package. Pin an available version with `apt-get install paws-runner=0.1.83`. Runner installation procedures are unchanged.

The package recommends `prometheus-node-exporter`, which apt installs unless you pass `--no-install-recommends`. When the exporter's `ARGS` in `/etc/default/prometheus-node-exporter` are missing, empty (the distro default) or set to `--web.listen-address=<this runner's Tailscale IPv4>:9100`, package configuration changes them to `ARGS="--web.listen-address=127.0.0.1:9100"` and restarts `prometheus-node-exporter.service`. It leaves any other `ARGS` alone.

To set up the dnf repository by hand, create `/etc/yum.repos.d/paws.repo`:

```ini
[paws]
name=Paws
baseurl=https://get.paws.boo/apt/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://get.paws.boo/apt/rpm/paws.asc
metadata_expire=6h
```

Then run `sudo dnf install paws-control-plane`. dnf asks to import the Paws key from `gpgkey` the first time. The repository serves `x86_64` and `aarch64` packages, lists the newest 10 versions, and `sudo dnf upgrade paws-control-plane` picks up each new release. dnf checks both the signature on the repository metadata (`repomd.xml.asc`) and the signature on each package. The packages in the repository are signed with `rpmsign` when they are published, so their checksums differ from the unsigned `.rpm` release assets and their `.rpm.sha256` files; the attestations cover the release assets.

Before anything is built, the `runner release` workflow runs `bun scripts/runner-compat.ts --deployed <ref>`: the new runner against the deployed Paws, and the new Paws against the runner at `MINIMUM_RUNNER_VERSION`. Each pair must pair, renew two heartbeats without a 403 and deliver a `login_check` command with its sealed sign-in, or the release fails. The deployed Paws is the `paws_ref` input of a manual run; otherwise it is the merge commit of the newest pull request that the release notes name, or the previous `v*` tag when they name none. CI runs the same check against the latest `v*` tag when a change touches `src/runner-protocol`.

For publishing, Pascal creates the GitHub `release` environment with required reviewer Pascal and deployment tags `v*`. Store these only as environment secrets: `PAWS_APT_R2_ACCOUNT_ID`, `PAWS_APT_R2_ACCESS_KEY_ID`, `PAWS_APT_R2_SECRET_ACCESS_KEY`, `PAWS_APT_R2_BUCKET`, `PAWS_APT_SIGNING_KEY`, and `PAWS_APT_SIGNING_PASSPHRASE`. Scope the R2 token to the apt bucket; the dnf repository lives in the same bucket under `rpm/`, signed with the same key. Without all six secrets, publication prints a skip message and succeeds. With secrets configured, apt publication requires runner packages for both architectures and dnf publication requires control-plane RPMs for both, and each fails before writing R2 if one is missing.

Keep the OpenPGP primary key offline. Create a signing subkey with a one-year expiry using `gpg --edit-key <primary-fingerprint>`, then `addkey` and the signing-only option. Export only the secret subkey with `gpg --armor --export-secret-subkeys <signing-subkey-fingerprint>!` for `PAWS_APT_SIGNING_KEY`. Upload the public key exports once as `paws.gpg` from `gpg --export <primary-fingerprint>` and `paws.asc` from `gpg --armor --export <primary-fingerprint>` at the bucket root. Serve the bucket read-only at `https://get.paws.boo/apt`, with the requested object versioning configured before publishing.

Publication uploads packages, immutable by-hash indexes, canonical indexes, then the signed `InRelease` object in separate phases. Only `InRelease` is published; there is no `Release` or `Release.gpg` fallback. After success, cleanup keeps three by-hash copies per index. Indexes list the newest ten versions in Debian version order; older package objects remain available for clients with cached indexes. Metadata expires after 90 days; every release renews its validity and signatures. For longer gaps between releases, manually run the `runner release` workflow, select the latest `v*` tag as the run ref, and set `resign_only=true`. After Pascal approves the `release` environment deployment, this verifies the existing `InRelease` and replaces only that signed object, leaving packages and package indexes unchanged. Dispatches on branches or with `resign_only=false` do not publish. There is no scheduled renewal.

dnf publication runs on each release, after the same tag gate and `release` environment approval. It signs each new RPM, rebuilds the metadata from the retained packages with `createrepo_c`, then uploads packages, metadata files, `rpm/paws.asc` (`gpg --armor --export` of the imported key), `repomd.xml.asc` and finally `repomd.xml`. It never deletes objects, so clients holding older metadata can still download what it lists, and it refuses to replace a published package with a different build of the same version. dnf metadata does not expire, so `resign_only` dispatches leave it alone; dry runs publish neither repository.
