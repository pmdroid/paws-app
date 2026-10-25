# Create a runner VM on exe.dev

Create VM on the Runners page makes a VM on [exe.dev](https://exe.dev), installs the Paws runner on it, enrolls it for the member who clicked, and waits for its first heartbeat. It is a shortcut for the manual steps in [Pair a remote Linux runner](runner-pairing.md), so prepare Paws the same way first: HTTPS workspace access, the runner authority, and the runner listener on port 8788.

## Give Paws an exe.dev token

Generate an exe.dev API token that may run `new`, `ls`, `ssh` and `rm`, and save it on the Paws machine:

```sh
printf '%s' '<exe.dev token>' | install -m 0600 /dev/stdin ~/.paws/secrets/exe-dev-token
```

Create VM appears on the Runners page once the token is there. `bun run paws doctor` reports it as `exe-dev`.

## Paws reachable only on Tailscale

The VM must reach Paws on both ports: 8787 for enrollment and 8788 for the runner's mTLS connection. When `PAWS_PUBLIC_URL` is a Tailscale hostname such as `https://agentbox.tailnet-name.ts.net:8787`, an exe.dev VM cannot reach it from the internet. Paws stays private, and the VM joins your tailnet instead.

1. In the Tailscale admin console, under **Settings > Keys**, generate an auth key that is:

   - **Reusable**, so every Create VM can use it.
   - **Pre-approved** (pre-authorized), so the VM joins without a manual approval.
   - **Tagged** `tag:paws-runner`, so the ACL below applies and the VM is not owned by your user.
   - **Not ephemeral**, so a stopped VM is not removed from the tailnet.

   Save it on the Paws machine:

   ```sh
   printf '%s' 'tskey-auth-…' | install -m 0600 /dev/stdin ~/.paws/secrets/tailscale-authkey
   ```

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

3. Run `bun run paws doctor`. The `tailscale-authkey` check passes when the key is present and readable.

With the key saved, Create VM adds a `tailnet` step after the install and before enrollment. The VM installs a pinned Tailscale static release whose SHA-256 Paws checks before unpacking. No install script runs. The VM then joins with `tailscale up --hostname=<vm name>` and waits until it resolves the Paws host and `/health` answers. A VM that is already on the tailnet only repeats that last check.

The auth key never appears on a command line. The VM makes a fresh RSA key in its root-only stage directory, Paws sends the auth key encrypted to it, and the VM decrypts it into a root-only mode 0600 file. That file is deleted right after `tailscale up`, whether the join succeeded or failed. The key is not logged and not put in the agent environment.

Without `~/.paws/secrets/tailscale-authkey`, the step is skipped and a Paws on a public URL provisions as before. When `PAWS_PUBLIC_URL` ends in `.ts.net` and the key is missing, Create VM refuses before it calls exe.dev and names the missing file.

If the step fails, the Runners page shows a `tailnet:` message. `cannot resolve <host>` usually means MagicDNS is off for the tailnet. `<url> did not answer` usually means the ACL does not let `tag:paws-runner` reach port 8787.
