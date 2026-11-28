# Create a runner VM on exe.dev

Create VM on the Runners page makes a VM on [exe.dev](https://exe.dev), installs the Paws runner on it, enrolls it for the member who clicked, and waits for its first heartbeat. It is a shortcut for the manual steps in [Enroll a remote Linux runner](runner-enrollment.md), so prepare Paws the same way first: HTTPS workspace access, the runner authority, and the runner listener on port 8788.

A runner Paws creates always gets Docker for agent jobs. The install step adds Docker Engine (the distro's `docker.io` package) when the image has none, runs the installer with `PAWS_RUNNER_DOCKER_ACCESS=grant`, then checks as `paws-agent`, the account agents run as, that `docker info` answers on `/run/paws-agent-docker/docker.sock`. That daemon is `paws-agent-docker.service`, a user unit of `paws-agent`'s systemd user manager, so its containers get cgroups ([Docker access for runner work](runner-enrollment.md#docker-access-for-runner-work)). If it doesn't within 30 seconds, the install fails with that reason instead of finishing a runner without Docker.

## Give Paws an exe.dev token

Generate an exe.dev API token that may run `new`, `ls`, `ssh`, `rm`, `pool list` and `pool adopt`, and save it on Settings › Runner VMs. exe.dev lists each subcommand on its own: `"pool"` does not allow `pool list`. Without `pool list` the Runners page cannot list pools and shows HTTP 403, and only team admins may `pool adopt`.

Create VM appears on the Runners page once the key of the configured provider is saved. The Prerequisites checks on Workspace › Integrations report it as `exe-dev`.

## Choose the provider

`provider` in `[vm_sizes]` names where Create VM makes new VMs: `exe-dev` (the default), `boat` or `instabox`. Each VM keeps the provider it was created with, so changing the setting affects only VMs created afterwards. Save the provider's API key on Settings › Runner VMs: the boat key or the InstaBox key. The Prerequisites checks report them as `boat` and `instabox` once the setting or a VM names that provider.

Each provider keeps its own size in `[vm_sizes.exe-dev]`, `[vm_sizes.boat]` or `[vm_sizes.instabox]`, which Create VM and issue VMs on that provider use. Saving refuses a size the provider can't give and lists the sizes it can:

| Provider   | `cpu` / `memory_gb`                        | `disk_gb`   | `image`, `pool` |
| ---------- | ------------------------------------------ | ----------- | --------------- |
| `exe-dev`  | any                                        | any         | allowed         |
| `boat`     | 2/4, 4/8, 8/16 or 16/32, or neither        | not allowed | not allowed     |
| `instabox` | your InstaBox plan's own sizes, or neither | not allowed | not allowed     |

To stop Create VM from using a provider without removing its key, list it in `off_providers`, for example `off_providers = ["boat"]`. Create VM also refuses a provider whose key the background check last found rejected. In both cases it creates nothing and names the reason, for example `boat is turned off on Settings › Runner VMs.` It doesn't fall back to another provider. VMs already on that provider can still be read, woken and deleted.

The size check runs again before Create VM calls the provider, so a size saved for another provider fails the VM's `create` step with the same message, for example `boat has no 6 vCPU / 12 GB size. Use 2/4, 4/8, 8/16 or 16/32.`

## boat

[boat](https://boat.dev) rents Ubuntu VMs in Germany, Finland and France, billed per second. Create an API key (it starts with `boat_`) with boat's `full-sandbox` scopes: create, read, update, stop, resume, delete and exec. Save it on Settings › Runner VMs as the boat key and set `provider = "boat"` in `[vm_sizes]`.

| `cpu` / `memory_gb` | boat type |
| ------------------- | --------- |
| 2/4                 | `small`   |
| 4/8 or neither      | `default` |
| 8/16                | `large`   |
| 16/32               | `xlarge`  |

Paws creates each boat VM with auto-stop turned off, since a runner that stops after an hour is no use. boat's trial plan refuses that, and Create VM fails with "boat's plan does not allow turning auto-stop off; a runner VM needs that." Turn off zero data retention on the boat account too: with it on, boat deletes a stopped VM, and Paws then reports the VM as missing.

## InstaBox

Create an [InstaBox](https://instabox.sh) API key (it starts with `ibk_`) with the scopes `machines:read`, `machines:write` and `machines:delete`, and save it on Settings › Runner VMs as the InstaBox key.

Create VM makes an InstaBox machine from the `agent-browser` template (Debian with systemd and Docker) named after the VM, and installs the runner on it as on exe.dev. `cpu` and `memory_gb` become the machine's vCPUs and memory; leave them out for InstaBox's default size. InstaBox accepts only the sizes your plan's `allowedSpecs` lists, and refuses any other with `spec_not_allowed`, which the VM's `create` step shows.

The machine's idle pause is turned off and it has no run limit, so a runner VM stays running, and billed, until it is deleted. Deleting the VM on its runner page deletes the machine.

exe.dev VM names are global, so another account may already hold `<name>-paws`. When exe.dev answers that a name is not available, Create VM tries `<name>-paws-2`, `<name>-paws-3` and so on.

Each Create VM makes a new VM, so a member may have several: `<name>-paws`, then `<name>-paws-2` and so on. A member may have at most 5 VMs that are not being deleted; the sixth Create VM is refused with "You already have 5 VMs. Delete one on its runner page first." Retry a failed VM from its runner page.

## Issue VMs on boat and InstaBox

Each item can run in its own issue VM. Paws picks the provider in this order: a VM host with a free slot, then boat, then InstaBox. It uses boat or InstaBox only when all of these hold:

- the provider's key is saved on Settings › Runner VMs, and the provider is not in `off_providers`;
- its hourly price is set under Spend on Settings › Issue VMs;
- its snapshot is set under Snapshots on Settings › Issue VMs.

The snapshot is the boat snapshot or the InstaBox snapshot id that every new issue VM on that provider starts from. Both are per workspace, so clearing one stops new issue VMs on that provider; VMs that already exist keep running. With no provider usable, items run on the workspace's runners as before. A workspace that has VM hosts but none online or free uses boat or InstaBox when one is usable. Otherwise its items wait for a host.

Paws creates the VM from the snapshot, installs the runner and enrolls it with a single-use token bound to that VM. The runner takes work only for its own item, and an item that has an issue VM runs only on that VM's runner.

## Paws reachable only on Tailscale

The VM must reach Paws on both ports: 8787 for enrollment and 8788 for the runner's mTLS connection. When `PAWS_PUBLIC_URL` or `PAWS_RUNNER_URL` is a Tailscale hostname such as `https://agentbox.tailnet-name.ts.net:8787`, an exe.dev VM cannot reach it from the internet. Paws stays private, and the VM joins your tailnet instead.

1. In the Tailscale admin console, under **Settings > Keys**, generate an auth key that is:

   - **Reusable**, so every Create VM can use it.
   - **Pre-approved** (pre-authorized), so the VM joins without a manual approval.
   - **Tagged** `tag:paws-runner`, so the ACL below applies and the VM is not owned by your user.
   - **Not ephemeral**, so a stopped VM is not removed from the tailnet.

   Save it on Settings › Runner VMs.

2. In the tailnet policy file, declare the tag and let `tag:paws-runner` reach only the Paws host on ports 8787 and 8788. Replace `100.x.y.z` with the Paws machine's Tailscale IP, and keep your existing rules:

   ```json
   {
     "tagOwners": {
       "tag:paws-runner": ["autogroup:admin"]
     },
     "hosts": {
       "paws": "100.x.y.z"
     },
     "acls": [{ "action": "accept", "src": ["tag:paws-runner"], "dst": ["paws:8787,8788"] }]
   }
   ```

   With grants instead of ACLs, the rule is `{ "src": ["tag:paws-runner"], "dst": ["paws"], "ip": ["tcp:8787", "tcp:8788"] }`. Nothing else should accept `tag:paws-runner` as a source.

3. Open Workspace › Integrations. The `tailscale-authkey` check under Prerequisites passes when the key is present and readable.

With the key saved, Create VM adds a `tailnet` step after the install and before enrollment. The VM installs a pinned Tailscale static release whose SHA-256 Paws checks before unpacking. No install script runs. On an exe.dev VM, before the join it installs and enables `systemd-resolved` with exe.dev's resolver (`169.254.169.254`) as its upstream in `/etc/systemd/resolved.conf.d/paws-upstream.conf`, and links `/etc/resolv.conf` to its stub. A boat VM keeps its own systemd-resolved, which already works with Tailscale. tailscaled then configures MagicDNS through resolved, and `*.localhost` names resolve to loopback as on Ubuntu CI. The VM then joins with `tailscale up --hostname=<vm name>` and waits until it resolves the Paws host and `/health` answers. Last, it checks that it resolves github.com, the Paws host and `probe.localhost` (to a loopback address); a failure ends the step with "the VM cannot resolve *.localhost names" and the check's output. A VM that is already on the tailnet repeats the resolved setup, which changes nothing once in place, and both checks.

The auth key never appears on a command line. The VM makes a fresh RSA key in its root-only stage directory, Paws sends the auth key encrypted to it, and the VM decrypts it into a root-only mode 0600 file. That file is deleted right after `tailscale up`, whether the join succeeded or failed. The key is not logged and not put in the agent environment.

Without a saved Tailscale auth key, the step is skipped and a Paws on a public URL provisions as before. When `PAWS_PUBLIC_URL` or `PAWS_RUNNER_URL` ends in `.ts.net` and the key is missing, Create VM refuses before it calls exe.dev and names the missing key and the URL that needs it. With `PAWS_RUNNER_URL` set, the VM's runner connects to that origin instead of the `PAWS_PUBLIC_URL` host.

If the step fails, the Runners page shows a `tailnet:` message. `cannot resolve <host>` usually means MagicDNS is off for the tailnet. `<url> did not answer` usually means the ACL does not let `tag:paws-runner` reach port 8787.
