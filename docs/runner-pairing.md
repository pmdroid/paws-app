# Pair a remote Linux runner

Pairing connects a Linux host to your Paws workspace. Claude and Codex run as the non-root `paws-agent` user with that user’s access to the host. Install the languages, browsers and other tools your repositories need on the VM. Each task receives its own workspace. Run the host commands over SSH on the VM. Use your browser to approve the host in Paws.

## Prepare Paws and the host

Set up [HTTPS workspace access](workspace-access.md) on the Paws machine and sign in as a workspace owner or administrator. For the first workspace, use the setup-code form described in that guide.

Initialize the runner authority once on the Paws machine, using the same Paws home as its service:

```sh
bun run paws runner-authority init
```

Add `PAWS_RUNNER_HOST` with the interface address Paws should listen on and `PAWS_RUNNER_PORT=8788` to the HTTPS service's environment, then restart Paws. On Tailscale, use the Paws machine's Tailscale IP as the listener address and its Tailscale DNS hostname in the HTTPS URLs below.

Configure transcript storage on the Paws machine using the same Paws home as its service:

```sh
printf '%s' '{"kind":"local"}' | bun run paws runner-storage configure
```

Paws stores transcripts in `~/.paws/runner-transcripts` with owner-only directory and file permissions. With a custom `PAWS_HOME`, it uses that home's `runner-transcripts` directory. Restart Paws after configuration. With runner HTTPS and GitHub App access configured, Paws sends agent work to paired hosts and keeps their transcripts on the Paws machine.

The VM needs outbound access to both endpoints. The default ports are TCP 8787 for dashboard access and HTTPS pairing, and TCP 8788 for the daemon's mTLS connection. Use the ports configured by your Paws operator. Both URLs must have a valid server certificate for their hostname.

Install the runner on the VM:

```sh
curl -fsSL https://get.paws.boo | sudo sh
```

The installer selects the AMD64 or ARM64 package from the latest GitHub release, checks its SHA-256, and installs it. The package creates the service accounts, verifier identity, runtime and systemd units. Pass a version to install that release:

```sh
curl -fsSL https://get.paws.boo | sudo sh -s -- 1.2.3
```

Package contents and upgrade behavior are in [Install a signed release](implementation/remote-hosts.md#install-a-signed-release).

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

`concurrency` sets the number of simultaneous tasks this host accepts, from 1 to 16, and defaults to 2. Each task has its own private workspace. Change the value in `/etc/paws-runner/config.json` and restart `paws-runner.service` to apply it. Paws receives the capacity through the runner's authenticated heartbeat. Pull request merges remain serialized.

For a private server certificate authority, add `serverCa` containing its PEM certificate text as a JSON string. Certificates issued by a publicly trusted authority use the default trust store.

Check dashboard connectivity from the VM:

```sh
curl --fail https://paws.example.com:8787/health
```

For a private CA, also pass `--cacert /path/to/server-ca.pem` to curl. The response includes `"ok":true`. The daemon receives its client certificate during approval and uses it on the runner listener.

## Sign in to the agents

Run the login command for each provider you intend to use on this host. The account and home directory must match the agent service:

```sh
sudo /usr/sbin/runuser --user paws-agent -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/claude auth login
sudo /usr/sbin/runuser --user paws-agent -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C /opt/paws-runner/bin/codex login --device-auth
```

Follow the provider's browser instructions. Provider credentials stay in the agent account's home on the VM.

## Request and approve pairing

On the VM, start pairing as the runner account. Replace `my-runner` with the host name you want to see in Paws:

```sh
sudo /usr/sbin/runuser --user paws-runner -- \
  /usr/bin/env -i --chdir=/var/lib/paws-runner \
  HOME=/var/lib/paws-runner PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C \
  /opt/paws-runner/bin/paws-runner runner pair \
  --config /etc/paws-runner/config.json --name my-runner
```

Keep this command running. It prints JSON containing a 16-character `code`, `requestFingerprint`, `verifierFingerprint` and `expiresAt`. The request expires after ten minutes.

1. Open your Paws dashboard at `https://paws.example.com:8787/status/#/runners`.
2. Sign in as an owner or administrator. Approval requires a sign-in within the last fifteen minutes.
3. Under **Pair a host**, enter the VM's `code` and select **Inspect host**.
4. Compare the displayed connection fingerprint with `requestFingerprint` in the VM terminal, and the verification key fingerprint with `verifierFingerprint`.
5. When both match, select **Approve runner**.

The VM command prints `"paired":true` with its runner and workspace identifiers, then exits successfully. If the request expires, run the same pairing command again and use its new code. Restarting an unexpired pending request retains its existing identity and code.

## Start the daemon and check health

On the VM:

```sh
sudo systemctl enable --now paws-runner-broker.socket paws-runner.service
sudo systemctl status paws-runner.service --no-pager
```

In **Runners**, select **Refresh runners**, then **View health** for the new host. Choose an agent and run **Check sign-in**, followed by **Check connection**. Connection checks call the selected agent, so use a provider account you have signed in to. The host's heartbeat updates **Last seen**, and the check receipts appear below the form.

For daemon errors, inspect its journal on the VM:

```sh
sudo journalctl -u paws-runner.service -n 100 --no-pager
```
