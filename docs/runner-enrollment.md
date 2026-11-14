# Enroll a remote Linux runner

Enrollment connects a Linux host to your Paws workspace. The runner daemon runs as the non-root `paws-runner` user, and the coding agents (Claude, Codex, Grok, OpenCode) and everything they start run as `paws-agent`, which can't read the runner's identity keys. Install the languages, browsers and other tools your repositories need on the VM. Each task receives its own workspace. Run the host commands over SSH on the VM. Paws gives you one command with a single-use token to run on the VM.

To have Paws make and enroll an exe.dev VM for you, including on a Paws reachable only on Tailscale, see [Create a runner VM on exe.dev](create-vm.md).

## Prepare Paws and the host

Set up [HTTPS workspace access](workspace-access.md) on the Paws machine and sign in as a workspace admin. The first workspace is created when a Linear workspace administrator authorizes Paws.

Add `PAWS_RUNNER_HOST` with the interface address Paws should listen on and `PAWS_RUNNER_PORT=8788` to the HTTPS service's environment, then restart Paws. Paws creates the runner identity on its first start with `PAWS_RUNNER_HOST` set; `bun run paws runner-authority init` with the service's Paws home does the same ahead of time, is optional, and is safe to rerun. On Tailscale, use the Paws machine's Tailscale IP as the listener address and its Tailscale DNS hostname in the HTTPS URLs below.

### A separate runner address and certificate

By default runners connect to the `PAWS_PUBLIC_URL` host on the listener's port, and the listener serves the dashboard certificate. To give runners their own address, set `PAWS_RUNNER_URL` to the HTTPS origin they connect to, for example `https://paws.example.ts.net:8788`. It must be an `https:` origin with no path, query or credentials, and it requires `PAWS_RUNNER_HOST`. `PAWS_RUNNER_HOST` and `PAWS_RUNNER_PORT` stay the bind address and port; the port runners use comes from `PAWS_RUNNER_URL` and may differ. Leaving `PAWS_RUNNER_URL` unset keeps the derived address, so paired runners keep working.

`PAWS_RUNNER_TLS_KEY_PATH` and `PAWS_RUNNER_TLS_CERT_PATH` give the listener its own certificate. They take the same checks as the public pair: absolute paths, a key with mode `0400` or `0600`, a key that matches, server purpose and a current validity period. Without them the listener serves the dashboard certificate. Either certificate must cover the `PAWS_RUNNER_URL` host, or Paws refuses to start and names the host. A `SIGHUP` reloads and checks the runner certificate too; a rejected one is journalled and Paws keeps running.

With `PAWS_PUBLIC_TLS=proxy` there is no dashboard certificate, so runner control needs all three: `PAWS_RUNNER_URL`, `PAWS_RUNNER_TLS_KEY_PATH` and `PAWS_RUNNER_TLS_CERT_PATH`. For example, with the dashboard on Render and runners on the tailnet through `tailscaled` in userspace mode on the same host:

```sh
PAWS_PUBLIC_DASHBOARD=1
PAWS_PUBLIC_TLS=proxy
PAWS_PUBLIC_URL=https://paws.onrender.com
PAWS_RUNNER_HOST=127.0.0.1
PAWS_RUNNER_PORT=8788
PAWS_RUNNER_URL=https://paws.example.ts.net:8788
PAWS_RUNNER_TLS_KEY_PATH=/etc/paws/runner.key
PAWS_RUNNER_TLS_CERT_PATH=/etc/paws/runner.crt
```

Serve port 8788 on the tailnet name to `127.0.0.1:8788` as plain TCP, so the mTLS handshake reaches Paws, and use `tailscale cert paws.example.ts.net` for the runner certificate. A VM made by Create VM then needs the Tailscale auth key ([Create VM](create-vm.md)).

Paws stores transcripts locally by default in `~/.paws/runner-transcripts` with owner-only directory and file permissions. With a custom `PAWS_HOME`, it uses that home's `runner-transcripts` directory. With runner HTTPS and GitHub App access configured, Paws sends agent work to enrolled hosts and keeps their transcripts on the Paws machine.

To use S3, pipe a JSON object containing `bucket`, `endpoint` (HTTPS), `region`, `accessKeyId`, `secretAccessKey`, and optionally `sessionToken` into `bun run paws runner-storage configure` using the same Paws home as its service, then restart Paws. Settings are encrypted in the protected secrets directory. New transcripts and agent session snapshots go to S3; existing local transcripts and snapshots in `~/.paws/agent-sessions` remain readable. To move them, run `bun run paws runner-storage migrate` with a `[database] url` configured. It copies each encrypted transcript and snapshot chunk to the bucket under its existing key, skips chunks already there, and prints counts and bytes for each kind. With `--delete-local` it removes each local file once the bucket's copy reads back identical. Reads still fall back to local files, so an interrupted migration is safe to rerun. Transcript chunks stored before encryption stay local until the encryption job seals them. Snapshot chunks are encrypted by Paws before upload, and the key stays in `~/.paws/secrets`. Runner inputs (attachments and long conversation context) and the artifacts runners upload go to the same bucket, under `runner-inputs/<run>/…` and `runner-artifacts/<run>/…`, so any Paws instance on the same database can serve or publish them. Each chunk is encrypted with the runner file key, `~/.paws/secrets/runner-file.key`, created on first use (every instance on the same database needs the same key file), and the chunks are deleted 7 days after their run ends. Inputs and artifacts already in the runner authority folder are uploaded once when Paws starts with S3 configured, then removed locally. Without S3 they stay in the runner authority folder as before. To select local storage again, configure `{"kind":"local"}` and restart Paws.

Manage object storage in Settings or with `paws runner-storage configure`. Restart Paws after changing storage so every kind of stored file uses the new settings. Use the storage check to confirm access before relying on it.

Set Closeout log retention in Settings. The default is 14 days for finished items; `0` keeps all logs. Open items retain their logs.

### Docker access for runner work

Runner work never uses the root Docker daemon at `/var/run/docker.sock`. When you opt in, the package gives agent jobs a rootless Docker daemon that runs as the account agents run as ([`agentUser`](#configure-the-runner)), so a container can bind-mount the worker's checkout (`docker run -v "$PWD":/workspace`, Compose volumes):

| `agentUser`              | Daemon                      | Runs as       | Socket                               | Data                          |
| ------------------------ | --------------------------- | ------------- | ------------------------------------ | ----------------------------- |
| `"paws-agent"` (default) | `paws-agent-docker.service` | `paws-agent`  | `/run/paws-agent-docker/docker.sock` | `/var/lib/paws-agent-docker`  |
| `"runner"`               | `paws-docker.service`       | `paws-runner` | `/run/paws-docker/docker.sock`       | `/var/lib/paws-runner-docker` |

`paws-agent-docker.service` is a user unit in `/etc/systemd/user` (with `ConditionUser=paws-agent`) that `paws-agent`'s own systemd user manager, `user@<uid>.service`, runs. Rootless Docker gets cgroups only through the systemd cgroup driver, which talks to that manager, so the daemon runs with `native.cgroupdriver=systemd` and its containers get memory, CPU and pids limits; kind needs them. `paws-docker.service` is still a system unit with the cgroupfs driver, so its containers get no limits.

Only the account a daemon runs as can reach its socket: the socket's directory is mode 0700. `paws-agent` never gets access to `paws-runner`'s daemon, whose containers could mount the runner's identity keys and spool. Package configuration reads `agentUser` from `/etc/paws-runner/config.json` and sets up only that account's daemon; when the value changed, it stops and removes the other account's unit. Its report (`docker.agentJobs` in the install output) names the daemon that serves agent jobs and whether its account reached it, and it fails with `not-isolated` when the other account can open the socket too. While the daemon runs, the runner gives each worker the `DOCKER_HOST` of its own account's socket; the agent and the Closeout checks inherit it. After changing `agentUser`, run `sudo PAWS_RUNNER_DOCKER_ACCESS=grant dpkg-reconfigure paws-runner` to move Docker to the new account. An agent only ever gets a `DOCKER_HOST` that names a local `unix://` socket. When the installer asks on a terminal, the default answer is no. For scripted installs, pass the choice:

```sh
curl -fsSL https://get.paws.boo | sudo sh -s -- --docker-access
curl -fsSL https://get.paws.boo | sudo sh -s -- --no-docker-access
```

With `--docker-access` on a host where Docker Engine (`dockerd`) is installed, the installer first runs `apt-get install -y rootlesskit uidmap slirp4netns dbus-user-session`. The package never installs Docker Engine itself.

Package configuration never prompts. It reads `PAWS_RUNNER_DOCKER_ACCESS=grant` or `deny`; to grant access later, install the packages above and run `sudo PAWS_RUNNER_DOCKER_ACCESS=grant dpkg-reconfigure paws-runner`. Without a choice, an upgrade keeps the daemon if it's set up and adds nothing if it isn't. Read [Docker access](security-considerations.md#runner-accounts-and-docker) before granting it.

On a grant, package configuration:

1. Checks for `rootlesskit`, `newuidmap`, `newgidmap` and `slirp4netns`, and for `paws-agent`'s daemon also `dbus-user-session`, which gives its user manager the D-Bus the systemd cgroup driver talks to. If any is missing, it names the package, sets nothing up and finishes the install.
2. Adds a 65536-id range for the account to `/etc/subuid` and `/etc/subgid` where it has none, after the highest existing range.
3. Creates the data directory (owned by the account, mode 0700) for images and containers.
4. Writes the daemon's unit, which runs the `dockerd-rootless.sh` launcher the package ships: `paws-docker.service` in `/etc/systemd/system`, or `paws-agent-docker.service` in `/etc/systemd/user`. For the user unit it also writes `/etc/systemd/system/user@.service.d/delegate.conf` (`Delegate=cpu cpuset io memory pids`) and `/etc/tmpfiles.d/paws-agent-docker.conf`, which keeps `/run/paws-agent-docker` owned by `paws-agent`, mode 0700, and runs `loginctl enable-linger paws-agent` so the user manager starts at boot.
5. Enables and starts the daemon, and reports whether its account can reach it and the other account can't. It reports `no-cgroups` when the daemon answers with `CgroupDriver: none`.

An upgrade from a release that ran `paws-agent-docker.service` as a system unit stops, disables and removes that unit, then starts the user unit on the same data directory, so images and volumes stay.

`deny`, or a host without Docker Engine, stops both daemons, removes their units and turns off linger for `paws-agent`. The data directories and the subordinate ids stay, so a later grant finds its images. Removing the package does the same; purging it also deletes both data directories and the `paws-runner` and `paws-agent` lines in `/etc/subuid` and `/etc/subgid`.

An earlier release added `paws-runner` to the `docker` group instead. An upgrade removes that membership when the install state in `/var/lib/paws-runner-install/docker-group.json` records that Paws added it. A membership Paws did not record adding stays, and the install prints a warning.

To check the daemon with the default `agentUser`:

```sh
D="sudo -u paws-agent env DOCKER_HOST=unix:///run/paws-agent-docker/docker.sock docker"
$D info --format '{{.SecurityOptions}}'                       # includes name=rootless
$D info --format '{{.CgroupDriver}}'                           # systemd
sudo python3 -I -B /usr/lib/paws-runner-package/install.py docker-check  # reachable, and no-cgroups when CgroupDriver is none
$D run --rm alpine echo ok
$D run --rm -v /var/lib/paws-agent:/w alpine ls /w             # a checkout's parent is readable
$D run -d --rm alpine sleep 20; ps -eo user,cmd | grep '[s]leep 20'  # host user is paws-agent
sudo -u paws-agent docker -H unix:///run/paws-docker/docker.sock ps          # permission denied
sudo -u paws-runner docker -H unix:///run/paws-agent-docker/docker.sock ps   # permission denied
sudo -u paws-agent docker -H unix:///var/run/docker.sock ps    # permission denied
sudo journalctl _SYSTEMD_USER_UNIT=paws-agent-docker.service   # when it does not start
```

With `"agentUser": "runner"`, use `sudo -u paws-runner`, `/run/paws-docker/docker.sock` and `paws-docker.service` instead.

## Configure the runner

On the VM, replace the example hostname, then create the protected configuration:

```sh
sudo install -o root -g paws-runner -m 0640 /dev/stdin /etc/paws-runner/config.json <<'JSON'
{
  "controlPlaneUrl": "https://paws.example.com:8787",
  "runnerApiUrl": "https://paws.example.com:8788"
}
JSON
```

`controlPlaneUrl` is the dashboard's HTTPS origin. `runnerApiUrl` is the same control plane's runner listener. Each URL contains only the scheme, hostname and optional port. Workspace admins choose a runner's repositories on its runner page: All repositories, or a list of the workspace's repositories. A runner added with **Add a runner** starts with an empty list and takes no work until an admin chooses its repositories there. A runner from **Create VM**, or one enrolled with another token, starts with All repositories. Paws keeps that choice; heartbeats never change it.

The host may also limit itself with an optional `allowedRepositories` list of exact GitHub `owner/repository` names in its config. The runner refuses any other repository, and `runner enroll` refuses an empty list, because a runner with one refuses every run. A runner takes an item only when its page setting and, when the host has one, its host config allow the item's repository, matched case-insensitively. The runner page shows the host config's list when the host reports one.

When no runner the delegator may use allows an item's repository, by either list, Paws asks in the item's Linear session which list to fix instead of waiting: the question names the runner, the list that refuses and the fix, with **Retry** and **Stop**. Fixing either list answers it as Retry on its own. See [Linear agent sessions](linear-agent-sessions.md#when-work-is-waiting).

The runner sizes the most simultaneous tasks this host accepts from its resources: one slot per 2 CPUs and 4 GiB of memory, the smaller of the two, from 1 to 16. It reads the CPUs the process may use and the total memory once when the daemon starts and logs one line such as `runner slots 6 from 12 CPUs and 31 GiB`. The install command and Create VM write no `concurrency`, so new runners size themselves. `concurrency` in the config, from 1 to 16, overrides the sizing; runners that already have it keep their value. Each task has its own private workspace. The value is the host's ceiling: change it in `/etc/paws-runner/config.json` and restart `paws-runner.service` to apply it. Below that ceiling, workspace admins set the runner's concurrency on its runner page. Paws returns that value in the heartbeat reply and the runner applies it to new work right away, with no restart. Lowering it does not stop running work; the runner takes no new work until it is under the new limit. The runner reports its ceiling and its applied value with each authenticated heartbeat. Runner releases from before this change ignore the setting and keep their config value. Pull request merges remain serialized.

`conversationConcurrency` sets simultaneous conversation turns, from 0 to 16, with a default of 2. These turns answer a person without taking a work slot. `0` disables them. Change it in `/etc/paws-runner/config.json` and restart `paws-runner.service`.

`agentUser` defaults to `"paws-agent"`, which separates agent work from the runner's identity. Keep that default for normal installations. Restart `paws-runner.service` after changing the configuration.

## Sign in to the agents

Run the login command for each provider you intend to use on this host, as the user agents run as. An agent's state belongs to that user: with `"agentUser": "paws-agent"` (the default) the runner's sign-in checks, usage probes and dashboard sign-ins start through `paws-agent@<executionId>.service` like any agent turn, so they run as `paws-agent`. Each package install or upgrade with `"paws-agent"` hands existing agent state in `/var/lib/paws-agent` and in each account home under `.paws-accounts` to `paws-agent:paws-agent`, recursively: `.codex`, `.claude`, `.claude.json`, `.grok`, `.bun`, `.config`, `.local` and `.cache` (OpenCode's config, data and cache are under the last three). Modes and the setgid bit stay as they are, and running the installer again changes nothing. `work/`, `.paws-skills`, `.paws-accounts` itself and each account home's `account.json` and holds stay `paws-runner`'s. Codex and OpenCode change the modes of their own state, which only its owner may, so they fail with `Operation not permitted` when it belongs to `paws-runner`. Run the installer again (`sudo dpkg-reconfigure paws-runner`) after switching an existing host to `"paws-agent"`. With `"agentUser": "runner"` the installer leaves ownership as it is and everything runs as `paws-runner`, as in runner 0.1.72; to go back to it on a host that was already handed over, give the folders above back to `paws-runner:paws-agent` (`chown -R`) before restarting. Both accounts use the provider state under `/var/lib/paws-agent` as `HOME`:

```sh
sudo /usr/sbin/runuser --user paws-agent -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/claude auth login
sudo /usr/sbin/runuser --user paws-agent -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/codex login --device-auth
```

With `"agentUser": "runner"`, use `--user paws-runner` instead.

Follow the provider's browser instructions. Provider credentials stay in `/var/lib/paws-agent` on the VM.

Or sign in from the dashboard, which is all the setup there is: open the runner on the **Runners** page. Its **Agents** table has one row per agent (Claude, Codex, Grok and OpenCode) with:

- the sign-in status, and **Sign in** or **Sign in again**, which opens that agent's sign-in terminal on the runner;
- the latest usage windows, such as "5-hour 62% · weekly 3%", with **Usage limit** or **Running on extra usage** once a window is spent;
- the **Keep running on extra usage** switch: when a window is spent, Paws keeps sending that agent work on this runner if no runner with quota left is free, and the provider bills the extra usage.

The runner's owner signs in; the owner and workspace admins change the switch. Everyone else sees the table read-only. New work runs as each runner's sign-in for the agent it needs.

### Sign-in belongs to the runner

Sign in to each coding agent on each runner you want to use. Credentials stay on that runner. Use the Runners page to check sign-in and usage, retry a failed sign-in, or choose whether work may continue on extra usage.

Paws chooses an eligible online runner with access to the repository and a ready sign-in for the requested agent. If none is ready, the item waits and the dashboard shows why. Check that runner's sign-in, quota, access and health before retrying.

## Add the host

1. Open your Paws dashboard at `https://paws.example.com:8787/dashboard/runners` and sign in. Any workspace member can add a host and owns the runner it adds.
2. Select **Add a runner**, enter the name you want to see in Paws, leave **Docker for agent jobs** ticked or untick it, and select **Create command**. The command runs the installer with `PAWS_RUNNER_DOCKER_ACCESS=grant` or `deny`, so it never depends on a terminal to ask.
3. Copy the command and run it on the VM. It installs the runner, writes `/etc/paws-runner/config.json` for this Paws, stores a single-use enrollment token in a root-owned mode 0600 file, enrolls, and starts `paws-runner.service`.

The token expires after ten minutes and works once. The runner appears under **Runners**, owned by you, as soon as the command prints `"paired":true`. It takes work once a workspace admin chooses its repositories on its runner page. Running the command again on an enrolled host that Paws still accepts changes nothing and leaves the token unused. If the token expires, create a new command.

When Paws no longer knows a runner, because its database was reset or the runner was revoked, every request from that runner gets 403 "Runner identity is revoked or expired" or "Runner is revoked; its work is fenced". The runner logs `This runner's identity is no longer known to <controlPlaneUrl>. Add it again from Runners and run the command there.` once, and tries again once a minute. To pair it again, add it from **Runners** and run the new command on the host. `runner enroll` asks Paws about the current identity before it uses the token. If Paws refuses it, the command moves `/var/lib/paws-runner/identity` to `identity.replaced-<time>`, drops the commands stored for the old identity, enrolls with the token and keeps `/etc/paws-runner/config.json`. A runner service that is still running exits when the new identity appears, and systemd restarts it. If Paws can't be reached or answers anything else, the identity stays and the token is unused.

To enroll by hand, write the token to a root-owned mode 0600 file and run:

```sh
sudo /opt/paws-runner/bin/paws-runner runner enroll \
  --config /etc/paws-runner/config.json --name my-runner \
  --token-file /etc/paws-runner/enrollment-token
```

The command starts as root to read the token, then continues as `paws-runner`. The token never appears on the command line.

## Start the daemon and check health

On the VM:

```sh
sudo systemctl enable --now paws-runner.service
sudo systemctl status paws-runner.service --no-pager
```

In **Runners**, select **Refresh runners**, then **View health** for the new host. Choose an agent and run **Check sign-in**, followed by **Check connection**. Connection checks call the selected agent, so use a provider account you have signed in to. The host's heartbeat updates **Last seen**, and the check receipts appear below the form.

For daemon errors, inspect its journal on the VM:

```sh
sudo journalctl -u paws-runner.service -n 100 --no-pager
```

## The agent's read-only GitHub token

During an implementation or fix turn, the agent can use the bundled GitHub CLI to read the task repository's issues, pull requests and Actions logs. Its token is read-only, limited to that repository and revoked when the turn ends. Code running during the turn can read it.

To disable this access, use Settings > GitHub access. See [GitHub access configuration](configuration.md#github_access).

## Working through a Paws outage

Runners keep working during a short Paws outage and retain events and results until the service returns. The offline work budget is at most 30 minutes and is also bounded by the command's expiry. Keep the runner online so it can reconnect.

## Restarting a runner

Restarting the runner interrupts unfinished turns. Paws retries lost work from the item's branch. A turn that has finished and saved its result resumes publication after the restart, including its candidate and transcript. Follow the issue page to see whether work is continuing or needs your decision.
