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

### Docker access for runner work

Runner work runs as `paws-runner`. If Docker Engine is already installed and running on the host, that account can't use it until it is in the `docker` group. The installer looks for a local, rootful Docker Engine at `/var/run/docker.sock` and checks access as `paws-runner`, with the environment runner work gets. It adds `paws-runner` to the existing `docker` group only when you opt in. When it asks on a terminal, the default answer is no. For scripted installs, pass the choice:

```sh
curl -fsSL https://get.paws.boo | sudo sh -s -- --docker-access
curl -fsSL https://get.paws.boo | sudo sh -s -- --no-docker-access
```

Package configuration never prompts. It reads `PAWS_RUNNER_DOCKER_ACCESS=grant` or `deny`; to grant access later, run `sudo PAWS_RUNNER_DOCKER_ACCESS=grant dpkg-reconfigure paws-runner`. Read [Docker access](security-considerations.md#docker-access-for-runner-work) before granting it.

The installer changes nothing when Docker isn't installed, when `paws-runner` already has access, or when you decline. It also leaves rootless Docker, a Docker context that points at another host, and Podman's `docker` command alone. It reports a missing `docker` group, a socket with an unexpected owner, group or mode, and a failed membership change, with the next step for each. A stopped daemon and a refused connection are reported separately. The installer doesn't install or start Docker, and doesn't change the socket.

The membership is added before the runner service starts again, so the daemon and the workers it launches get it. Package configuration still refuses to run while agent work is active. A runner daemon or worker you started by hand keeps the groups it started with: stop it and start it again from a new process.

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

Workspace admins also choose a runner's repositories on its runner page: All repositories, the default, or a list of the workspace's repositories. Paws keeps that choice; heartbeats never change it. A runner takes an item only when both its page setting and its host config allow the item's repository, matched case-insensitively. The runner page shows the host config's list when the host reports one.

`concurrency` sets the most simultaneous tasks this host accepts, from 1 to 16, and defaults to 2. Each task has its own private workspace. The value is the host's ceiling: change it in `/etc/paws-runner/config.json` and restart `paws-runner.service` to apply it. Below that ceiling, workspace admins set the runner's concurrency on its runner page. Paws returns that value in the heartbeat reply and the runner applies it to new work right away, with no restart. Lowering it does not stop running work; the runner takes no new work until it is under the new limit. The runner reports its ceiling and its applied value with each authenticated heartbeat. Runner releases from before this change ignore the setting and keep their config value. Pull request merges remain serialized.

Runner cleanup is generation scoped. Paws records cancellation by ending execution authority, but keeps the slot until teardown is confirmed. The runner records `cleaning` before stopping its worker, retains that entry across restart, and keeps it in heartbeat `live` reports while stopping rejects or hangs. Admission counts that entry, and cleanup retries continue alongside heartbeats.

A cancel never waits for the worker to stop. The runner acknowledges the cancel when it receives it, and that acknowledgement does not confirm teardown. Each broker stop attempt gets 30 seconds. A stop that rejects or takes longer marks the cleanup as degraded. The runner keeps the slot and tries again after 5 seconds. The wait doubles up to one minute. A stop still in flight is never called a second time; the retry waits on that same call. Command processing waits for a stopping worker at most once, and never after an attempt failed. The runner journal keeps each unresolved stop with its start time, failure count and last error, so a restarted runner shows the same diagnosis and resumes the retries. The runtime status lists these entries under `cleanup`, and the runner log reports the first failure and the later confirmation.

Runner 0.1.55 adds durable `terminated` heartbeat reports. Each report names the run, generation and work command, or a cancel command for a generation that never started. The broker must confirm that the worker and its processes have stopped before the runner records this report. Paws matches all these fields, saves `runner_work.teardown_confirmed_at`, and echoes the report. The runner retries reports until that echo arrives. An old acknowledgement cannot confirm a newer generation. Command receipt, cancellation expiry and absence from `live` do not confirm teardown on their own.

Two other facts also resolve cleanup. A stored worker result for the same run, generation and command means the worker exited, because the runner saves a result only after its worker exits or its stop resolves. A work command the runner never acknowledged and never named in `live` is resolved once the runner sends a heartbeat with termination reports after that command expired. Such a runner journals every command it admits and keeps it in `live` until the broker confirms termination. A missing command row stays held. Paws records `runner.terminations_since` at a runner's first heartbeat with termination reports. Until then the runner keeps the earlier release behaviour: it acknowledges a cancel only after its worker stop resolves, so that acknowledgement resolves cleanup, as does work Paws fenced because the runner stopped reporting it. Neither applies to events after `terminations_since`. On upgrade the runner stops each execution an older release had already ended, and any execution whose result is still waiting for delivery, one at a time through the broker. It reports each termination once the stop resolves. A cancel for a generation that has no running entry is confirmed at once only when no journaled execution of that generation still awaits a confirmed stop. Those executions take no local slot and are not reported in `live`. Between-command reservations continue until the owning run ends.

A runner with unresolved cleanup stays online for placement. Its unresolved work counts against the runner's capacity, so a runner with a free slot still takes other work.

Unresolved teardown uses the existing runner capacity wait. It defers admission without spending execution retries or failing the item. This contract is the basis for the cancellation responsiveness and liveness follow-ups in PAS-961 and PAS-964.

Paws fences acknowledged work as lost only when a `live` report proves it is missing. Runner 0.1.59 sends `liveAfter` with each `live` report. It holds the `observedAt` of the last heartbeat reply the runner had received before it took that list, or 0 after a restart. Both times come from the Paws clock. A runner adds work to its list before it acknowledges the command. So Paws fences only work it acknowledged at or before `liveAfter`, however late a busy Paws processes the heartbeat. Work acknowledged later is neither confirmed nor lost by that report. Work that really disappeared is fenced on the next heartbeat. Runners that send no `liveAfter` keep the older rule: work acknowledged at least 30 seconds before Paws processed the heartbeat. Assigning a new generation clears `confirmed_at`, `lost_at` and `teardown_confirmed_at`. Liveness writes match the run and generation, so a report about an older generation never confirms the new one.

A stored result that Paws refuses with 409, or with 403 naming the work as fenced, is rejected and never retried. A refusal with another 4xx status cannot succeed on retry either. That covers every 4xx except 401, 403, 408, 425 and 429. The runner marks such a result undeliverable and keeps it in its journal with the HTTP status and reason. It stops retrying and reports the refusal in the runner log. The run then leaves `live`, so Paws fences it as lost and recovers the item. Outages, 5xx answers, expired grants and other 403 answers keep retrying with backoff.

The daemon keeps a receipt for every command it accepted, to reject replays, and the command payload until its acknowledgement reaches Paws. Every 10 minutes, while polling commands, it deletes acknowledged commands and their receipts that expired more than a day earlier. An expired command fails verification before its receipt is checked, so the deletion does not admit replays. It never deletes a command whose acknowledgement is still pending or a receipt that has not expired.

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

### Agent accounts and bindings

Paws records each sign-in as a binding of a logical agent account (`src/db/agent-accounts.ts`). An account belongs to one workspace and one agent, and has a label and an enabled flag. It is separate from the agent, model and effort profile in `config.toml`. A binding is one runner's sign-in for one account. One account can have bindings on several runners, and each binding belongs to exactly one workspace, account and agent.

The sign-in above is the runner's default sign-in. Paws keeps it as a legacy binding with id `legacy_<agent>_<runnerId>` under the workspace's legacy account `legacy_<agent>_<workspaceId>`. Its quota scope is `unknown`: Paws does not know whether two runners' default sign-ins are the same provider account, so it treats neither as proof of separate quota. A binding added to a named account is an explicit link, with quota scope `account`: it shares that account's quota. Paws never derives an account from credentials, email addresses or token equality, and credentials stay on the runner.

A command without `account` runs as the default sign-in, as before. A signed `run`, `review`, `task`, `helper`, `probe`, `login` or `login_check` command may name `account: { accountId, bindingId }`. Paws queues a named command only when the runner is at least 0.1.60, its latest heartbeat reported `accounts.protocol` 1 or later, and `accounts.bindings` lists that binding for the command's agent. A named `login` is the exception: it is how a runner first holds a binding, so it needs only the version and protocol. A runner older than 0.1.60 refuses the unknown field, and a newer runner refuses any other named command for a binding it does not hold (`account_unavailable`). Neither runs the default sign-in instead. A result must repeat the command's `account` exactly.

### Isolated binding homes

The default sign-in lives in `/var/lib/paws-agent`. Each named binding gets its own private home, `/var/lib/paws-agent/.paws-accounts/<bindingId>` (`src/runner-execution/accounts.ts`). The runner points `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` at that home for every named command: runs, reviews, tasks, helpers, probes, sign-in checks and sign-ins. Claude, Codex, Grok and OpenCode keep their credentials, sessions and settings there, the Codex Closeout hook overlay links that home's `.codex`, and session snapshots are read from and restored to it, so two accounts of one agent never read or write each other's files. `XAI_API_KEY` never reaches a named command. Runtimes installed with mise stay shared in the default home. Every folder on the way must be a real directory owned by the runner account; a symlink or another owner fails the command, and group or other access is removed.

`runnerAccountAgentUnsupported` in `src/runner-protocol/accounts.ts` lists, for each agent, why it cannot run as a named account. All four agents are supported today; an agent with a reason there is refused by Paws and by the runner instead of running as the default sign-in.

Sign in to a named binding from the runner's accounts API with `POST /api/runners/<runnerId>/accounts/<agent>/login?binding=<bindingId>`. Without `binding`, the sign-in is the default one, as before. The provider signs in to a staged folder inside the binding's home; the runner then renames the new credential files over the old ones and only then records the binding as held and reports it in its heartbeat. A cancelled, failed or crashed sign-in leaves the previous credentials, and a first sign-in that never finishes leaves the binding unheld. A disabled account can still sign in.

Replacing a named binding's credentials never changes the identity of work already running with them. Paws refuses to start that sign-in while work with the binding is running (HTTP 409). On the runner, every execution holds its binding home while its worker is alive, and a sign-in publishes only when no other execution holds it; new executions for that binding fail to start during the moment it publishes. A hold stays while the worker or any process tagged with its execution is alive, or while its admission is still starting the worker; only then is a hold left by a crash ignored. A publish lock is ignored once its sign-in process is gone. Credentials are never copied between runners: each runner signs in on its own.

A named sign-in or sign-in check does not change the default sign-in's readiness, quota or usage rows.

Agents on a runner all run as the one runner account, so a binding home is isolated from the agents' own configuration, not from a tool call that deliberately reads another path as that account.

Paws records the account and binding of every agent command in `runner_command_account` before it queues the command. Disabling or removing an account keeps those rows. A disabled account takes no new execution commands but can still sign in and be checked. Removing an account removes its bindings too, and the default sign-in account cannot be removed.

### Account order

`config.toml` may list the accounts each role tries, in order, by account id. A list never changes the agent, model or effort: every account in it must sign in the agent of the profile it runs, and a different account is not an independent reviewer.

```toml
[agents.defaults.accounts]
implementer = ["01J...A", "01J...B"]
reviewer = ["legacy_codex_<workspaceId>"]
reviewer_fallback = ["01J...X"]   # needs [agents.defaults.reviewer_fallback]

[agents.projects."owner/repo".accounts]
implementer = ["01J...B"]
```

A project's list replaces the default list for that role. Without one, the project inherits the default list only while it runs the default agent for that role; a project that switches agent and lists no accounts uses that agent's default sign-in. The reviewer fallback list is set only at the defaults and is tried after the reviewer's accounts are spent. With no list, a role runs the default sign-in as before.

Each list holds 1 to 8 distinct account ids (a ULID or a `legacy_<agent>_<id>` default sign-in). Names, paths and credentials are refused. Saving in Settings also refuses an id this server does not know, a removed or disabled account, and an account for another agent. `GET /api/settings/agents` returns a `revision` of `config.toml`; a `PUT` that sends an older `revision` gets HTTP 409 and changes nothing.

Each run's `agent-profile.json` keeps the resolved lists with a short policy `revision`. A save reaches runs that are waiting, including a run in a usage-limit wait, which then retries with the new order; a run holding a live runner lease keeps its lists until its turn ends. Admission (`admitAgentAccounts` in `src/db/agent-accounts.ts`) reads accounts again, so a disabled, removed, foreign or other-agent account is skipped even when a saved list still names it.

Every agent turn, review, probe and session helper (classification, repository selection and finding grouping) admits the list before placement (`dispatchAccount`). When no account in it is eligible, nothing is placed and Paws never uses the default sign-in instead: a reviewer with a reviewer fallback profile moves to that profile, and other work waits and retries as a transient `AccountPolicyUnavailable`. The journal records each decision with the policy revision, the accounts admitted and the accounts skipped and why.

### Account and runner selection

Placement (`src/runner-placement/placement.ts`) chooses an account and a runner together. Each runner that passes the runner checks (who may use it, its owner, online and active, repository access, version, load and work affinity) is offered once per admitted account, in the list's order. Without a list the only account is the default sign-in, so single-account installations place exactly as before. An account is offered on a runner only when:

- for a named account, the runner holds a live binding of it, the runner is at least 0.1.60 and reported that binding, and the binding's health does not block it;
- for the default sign-in, the runner's agent is signed in and outside its quota cooldown, and the provider and model are not blocked;
- the account is below its `concurrency`, counted across every binding of the account, so binding one account to several runners never multiplies its slots.

Candidates are ordered by account first, then by the runner ranking: session holder, own runners, current and recent load, quota and fair share. So a second account on the same runner is used when the first account is exhausted there, and one account runs on whichever of its runners is free. A runner whose default sign-in expired still runs its named accounts. Each rejection names the account (`B: account has no binding on this runner`, `A: agent account quota cooldown`) in the run's placement wait.

Assignment rechecks the choice inside the same `BEGIN IMMEDIATE` transaction that signs and stores the command: the account is still enabled and in the order, its binding is live and supported, the command carries exactly the chosen account and binding, its health does not block it, and the account has a free slot. If any check fails, the whole assignment rolls back with a `PlacementRaceError`, so no runner slot or account slot is held, and the work is placed again. `runner_execution_usage.account_policy_revision` records the policy revision of every assignment, and `runner_command_account` its account and binding.

An account slot is held by an execution whose usage has not ended and whose command is still live: an unexpired helper, or an unexpired command that is still its run's current generation (`accountSlotsInUse` in `src/db/agent-accounts.ts`). A result settles only its own command id, so a stale or replayed result from an older generation, or a command lost in a restart, cannot release the newer generation's account or runner reservation.

A named account's result updates only that account's health; the runner's default sign-in keeps its own quota and sign-in state. A retry after a named binding needs sign-in avoids that binding, not the whole runner. When no pair can run, the work waits: busy accounts and runners are a capacity wait, and blocked accounts pause until the earliest next check among them (a known reset, a bounded backoff or a model recheck). A binding that needs sign-in has no next check, so the run reports why each runner was rejected until someone signs in again. An account of another agent never blocks a profile that does not use it.

### Account health

Paws records what each agent result, login check and completed sign-in shows about an account in `agent_account_health` (`src/db/agent-account-health.ts`), at the scope the fact holds:

| Kind       | Scope                                                              | Set by                                               | Cleared by                                                      |
| ---------- | ------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------- |
| `quota`    | The account for a named binding; the binding for a default sign-in | A usage limit (`exhausted`) or a low reading (`low`) | A successful turn, or a login check that reads spare usage      |
| `auth`     | The binding: its runner-local sign-in                              | A result that needs sign-in, or a failed login check | A completed sign-in, a passing login check or a successful turn |
| `provider` | Every account of the agent in the workspace                        | An overloaded or region-restricted provider          | A successful turn on any account of the agent                   |
| `model`    | One model at the quota scope                                       | A model the account cannot use                       | A successful turn with that model, or six hours                 |

Runner and network faults (a lost heartbeat, a timeout) and ordinary task or test failures record nothing, so they never disable a healthy binding or account. `classifyAgentFailure` in `src/runner-placement/account-health.ts` decides the kind.

Each row keeps the command that produced it, when the fact was observed, the reset time and the next check. A failure is observed when it finished, a success when its turn started and a login check when Paws issued it. A newer observation replaces an older one and a failure wins a tie, so a late login check or result cannot erase a newer failure. A repeated command id changes nothing. A success from a removed binding, a disabled or removed account, or a revoked runner is ignored, so it cannot make that binding usable again.

A known reset is rechecked a minute after it passes. An unknown one backs off from 15 minutes, doubling per repeat up to 4 hours, with up to 20% jitter derived from the scope. Once the next check passes, one real attempt on the account may run; the account's other bindings wait for its result. A low reading only ranks the account later. A sign-in failure has no next check: the binding waits for a completed sign-in. A provider restriction blocks every account of that agent, so rotating accounts cannot bypass it. Rows are in SQLite, so cooldowns survive a restart, and **Resume now** on a usage-limit pause makes the agent's account cooldowns due.

`bindingReadiness` reports why a binding cannot run as one of `revoked`, `removed`, `disabled`, `offline`, `paused`, `auth-required`, `provider-restricted`, `unsupported-model`, `exhausted` or `busy`. `busy` covers a full runner and an account at its `concurrency` limit. A usage-limit wait resumes at the earliest reset or account recheck, and waiting spends no part of the run's usage-limit budget: only usage-limited attempts, and waits that end early or would not wait, count toward it.

## Add the host

1. Open your Paws dashboard at `https://paws.example.com:8787/dashboard/runners` and sign in. Any workspace member can add a host and owns the runner it adds.
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
the worker left behind in the background, so heartbeats continue. While that
stop is pending or failing, the runner keeps naming the run in `live`, keeps its
slot, and retries the stop. Neither stop posts a result for an unfinished turn,
so once the stop succeeds the next heartbeat leaves the work out. Paws fences
that work as lost and retries it
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
record. On the next start, the runner names the run in its first heartbeat,
stops any worker left behind, and then resumes publishing from the stored
session and transcript offsets. The turn is
not run again. A push whose result was not recorded is sent again. It finds the
candidate, or its copy rebased onto a moved branch, already there and records
that commit. Paws then gets the worker's own outcome with the published commit.

Paws's answer still decides. A fence, a cancellation, a missing lease, a lease
that lapses while Paws is unreachable, or a fence refusal of a request ends the
publication. None of them posts an error. The journal keeps the outcome marked
refused, with the reason, so a refused outcome stays distinct from a lost one.
