# Enroll a remote Linux runner

Enrollment connects a Linux host to your Paws workspace. Claude and Codex run as the non-root `paws-runner` user. Install the languages, browsers and other tools your repositories need on the VM. Each task receives its own workspace. Run the host commands over SSH on the VM. Paws gives you one command with a single-use token to run on the VM.

To have Paws make and enroll an exe.dev VM for you, including on a Paws reachable only on Tailscale, see [Create a runner VM on exe.dev](create-vm.md).

## Prepare Paws and the host

Set up [HTTPS workspace access](workspace-access.md) on the Paws machine and sign in as a workspace admin. The first workspace is created when a Linear workspace administrator authorizes Paws.

Initialize the runner authority once on the Paws machine, using the same Paws home as its service:

```sh
bun run paws runner-authority init
```

Add `PAWS_RUNNER_HOST` with the interface address Paws should listen on and `PAWS_RUNNER_PORT=8788` to the HTTPS service's environment, then restart Paws. On Tailscale, use the Paws machine's Tailscale IP as the listener address and its Tailscale DNS hostname in the HTTPS URLs below.

Paws stores transcripts locally by default in `~/.paws/runner-transcripts` with owner-only directory and file permissions. With a custom `PAWS_HOME`, it uses that home's `runner-transcripts` directory. With runner HTTPS and GitHub App access configured, Paws sends agent work to enrolled hosts and keeps their transcripts on the Paws machine.

To use S3, pipe a JSON object containing `bucket`, `endpoint` (HTTPS), `region`, `accessKeyId`, `secretAccessKey`, and optionally `sessionToken` into `bun run paws runner-storage configure` using the same Paws home as its service, then restart Paws. Settings are encrypted in the protected secrets directory. New transcripts and agent session snapshots go to S3; existing local transcripts and snapshots in `~/.paws/agent-sessions` remain readable. Snapshot chunks are encrypted by Paws before upload, and the key stays in `~/.paws/secrets`. To select local storage again, configure `{"kind":"local"}` and restart Paws.

The VM needs outbound access to both endpoints. The default ports are TCP 8787 for dashboard access and HTTPS enrollment, and TCP 8788 for the daemon's mTLS connection. Use the ports configured by your Paws operator. Both URLs must have a valid server certificate for their hostname.

Install the runner on the VM:

```sh
curl -fsSL https://get.paws.boo | sudo sh
```

The installer selects the AMD64 or ARM64 package from the latest GitHub release, checks its SHA-256, and installs it. The package creates the service accounts, verifier identity, runtime and systemd units. Pass a version to install that release:

```sh
curl -fsSL https://get.paws.boo | sudo sh -s -- 1.2.3
```

Package contents and upgrade behavior are in `deploy/linux`: the release manifest, the signed package builder, and the installer.

## Configure the runner

On the VM, replace the example hostname and repository names, then create the protected configuration:

```sh
sudo install -o root -g paws-runner -m 0640 /dev/stdin /etc/paws-runner/config.json <<'JSON'
{
  "controlPlaneUrl": "https://paws.example.com:8787",
  "runnerApiUrl": "https://paws.example.com:8788",
  "allowedRepositories": ["your-org/your-repo"],
  "concurrency": 2
}
JSON
```

`controlPlaneUrl` is the dashboard's HTTPS origin. `runnerApiUrl` is the same control plane's runner listener. Each URL contains only the scheme, hostname and optional port. `allowedRepositories` lists the exact GitHub `owner/repository` names this host may execute.

`concurrency` sets the most simultaneous tasks this host accepts, from 1 to 16, and defaults to 2. Each task has its own private workspace. The value is the host's ceiling: change it in `/etc/paws-runner/config.json` and restart `paws-runner.service` to apply it. Below that ceiling, workspace admins set the runner's concurrency on its runner page. Paws returns that value in the heartbeat reply and the runner applies it to new work right away, with no restart. Lowering it does not stop running work; the runner takes no new work until it is under the new limit. The runner reports its ceiling and its applied value with each authenticated heartbeat. Runner releases from before this change ignore the setting and keep their config value. Pull request merges remain serialized.

Runner cleanup is generation scoped. Paws records cancellation by ending execution authority, but keeps the slot until teardown is confirmed. The runner records `cleaning` before stopping its worker, retains that entry across restart, and keeps it in heartbeat `live` reports while stopping rejects or hangs. Admission counts that entry, and cleanup retries continue alongside heartbeats.

Runner 0.1.55 adds durable `terminated` heartbeat reports. Each report names the run, generation and work command, or a cancel command for a generation that never started. The broker must confirm that the worker and its processes have stopped before the runner records this report. Paws matches all these fields, saves `runner_work.teardown_confirmed_at`, and echoes the report. The runner retries reports until that echo arrives. An old acknowledgement cannot confirm a newer generation. Command receipt, cancellation expiry and absence from `live` do not confirm teardown. Older runners without termination reports keep unresolved cleanup held until they upgrade and reconcile it. A consumed worker result also confirms teardown through the existing `finish` path. Between-command reservations continue until the owning run ends.

Unresolved teardown uses the existing runner capacity wait. It defers admission without spending execution retries or failing the item. This contract is the basis for the cancellation responsiveness and liveness follow-ups in PAS-961 and PAS-964.

For a private server certificate authority, add `serverCa` containing its PEM certificate text as a JSON string. Certificates issued by a publicly trusted authority use the default trust store.

Check dashboard connectivity from the VM:

```sh
curl --fail https://paws.example.com:8787/health
```

For a private CA, also pass `--cacert /path/to/server-ca.pem` to curl. The response includes `"ok":true`. The daemon receives its client certificate when it enrolls and uses it on the runner listener.

## Sign in to the agents

Run the login command for each provider you intend to use on this host. The daemon runs the agent as this same account, with provider state under `/var/lib/paws-agent`:

```sh
sudo /usr/sbin/runuser --user paws-runner -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/claude auth login
sudo /usr/sbin/runuser --user paws-runner -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/codex login --device-auth
```

Follow the provider's browser instructions. Provider credentials stay in `/var/lib/paws-agent` on the VM.

## Add the host

1. Open your Paws dashboard at `https://paws.example.com:8787/status/runners` and sign in. Any workspace member can add a host and owns the runner it adds.
2. Select **Add a runner**, enter the name you want to see in Paws, and select **Create command**.
3. Copy the command and run it on the VM. It installs the runner, writes `/etc/paws-runner/config.json` for this Paws, stores a single-use enrollment token in a root-owned mode 0600 file, enrolls, and starts `paws-runner.service`.

The token expires after ten minutes and works once. The runner appears under **Runners**, owned by you, as soon as the command prints `"paired":true`. Running the command again on an enrolled host changes nothing. If the token expires, create a new command.

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

## Working through a Paws outage

Runner 0.1.55 keeps working while Paws cannot be reached. Deploy Paws's lease-credit
support before upgrading runners. The 30-minute budget counts monotonic awake work;
sleep, wall-clock jumps and idle waits do not spend it. The stop deadline remains
capped by 30 minutes and command expiry. Helpers retain their signed deadlines.

A missing lease or fence stops the worker immediately. Network failures use the
offline budget. Events and results remain local until accepted, including across
runner restarts. Pending results remain in heartbeats until delivered. Only a
fence refusal or HTTP 409 ends retries; other 4xx and parse errors stay retryable.
Transcript replay validates the consumed bytes. Optional session uploads have a
five-attempt bound. Result retries renew grants, back off up to one minute, and
reuse the execution and command identifiers so Paws recognizes repeated delivery.

## Restarting the runner mid-turn

A crash and a graceful stop of `paws-runner.service` end an unfinished turn the
same way. A graceful stop interrupts the worker. After a crash, the runner stops
the worker left behind before it sends its first heartbeat, and a failed stop
fails startup. Neither stop posts a result for an unfinished turn, so the next
heartbeat leaves the work out. Paws fences that work as lost and retries it
through its usual infrastructure retries, continuing from the item's branch.
Linear shows "The runner lost this run after it restarted; continuing from the
branch." A result the runner had saved is delivered unchanged. An agent error
the worker wrote before the crash is delivered as that error. A turn that
finished but never started publishing is recovered as lost work too.

## Restarting the runner while it publishes

A finished turn starts publishing by recording the worker's outcome in the
runner's execution journal. Publishing uploads the agent session, pushes the
candidate and drains the transcript. After the push, the journal records the
commit the branch got. A crash or a graceful stop during publishing keeps that
record. On the next start, the runner names the run in its first heartbeat and
resumes publishing from the stored session and transcript offsets. The turn is
not run again. A push whose result was not recorded is sent again. It finds the
candidate, or its copy rebased onto a moved branch, already there and records
that commit. Paws then gets the worker's own outcome with the published commit.

Paws's answer still decides. A fence, a cancellation, a missing lease, a lease
that lapses while Paws is unreachable, or a fence refusal of a request ends the
publication. None of them posts an error. The journal keeps the outcome marked
refused, with the reason, so a refused outcome stays distinct from a lost one.
