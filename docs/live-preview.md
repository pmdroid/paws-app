# Live product previews

An implementer calls `show_preview` after committing its work and running the command checks. Paws starts the fixture product on the runner and asks the delegator or project lead to try it on the issue page. The tool waits for the decision. Accept resumes the same call; Request changes or a Linear reply uses `restart()` with the feedback. A Linear reply cannot accept.

```json
{
  "command": ["bun", "--no-env-file", "run", "preview:fixtures"],
  "port": 3123,
  "startPath": "/settings",
  "checklist": ["Save a display name and reload", "Try the form at phone width"],
  "checkId": "live-preview"
}
```

The command is argv, without an implicit shell. It must bind to `127.0.0.1` and use fixture data. The runner rejects an occupied port and a listener bound to a public interface. Give Bun `--no-env-file` and disable any framework's automatic credential loading in the fixture command. The app gets a temporary home and an environment allowlist, including `PORT`, `HOST=127.0.0.1`, `NODE_ENV=test`, and `PAWS_PREVIEW_FIXTURES=1`. It inherits no agent login, Paws socket, or credential variables. The runner's process supervisor owns its descendants.

Previews stop after 60 minutes, on a decision, on cancellation, or when the app exits. A stopped preview cannot be accepted; reply in Linear or request changes in Paws to restart it. Accept is evidence for exactly the previewed commit. A later commit, including a rebase, needs another preview. An optional preview also holds publication.

Add a policy requirement under `items` in `.agents/closeout.yaml`:

```yaml
specVersion: "0.1"
items:
  - id: live-preview
    type: preview
    approval: human
    paths: ["src/web/**", "landing/**"]
```

The equivalent canonical form is `kind: preview` with `gate: beforePR`. A paths miss skips the check. No command or screenshot can satisfy it. When verification reaches a missing preview, Paws returns the item to the implementer to call `show_preview`.

## Runner and tailnet setup

Use runner 0.1.49 or later, Tailscale Services, and Linux `ss`. Configure `PAWS_PUBLIC_URL` with the HTTPS dashboard address. Each runner needs its own disjoint set of service names, with one service per execution slot. For example, on the runner create root-owned `/etc/paws/preview-services.json`, readable by `paws-runner`:

```json
["paws-preview-1", "paws-preview-2"]
```

Define those services in the Tailscale admin console before advertising them. Join runners with a pre-approved auth key tagged `tag:paws-runner`, as described in [Create a VM](create-vm.md). Grant the runner user permission to operate Serve once:

```sh
sudo tailscale set --operator=paws-runner
```

The tailnet policy needs entries for every assigned service. Use explicit names:

```json
{
  "tagOwners": { "tag:paws-runner": ["autogroup:admin"] },
  "autoApprovers": {
    "services": {
      "svc:paws-preview-1": ["tag:paws-runner"],
      "svc:paws-preview-2": ["tag:paws-runner"]
    }
  },
  "grants": [
    {
      "src": ["autogroup:member"],
      "dst": ["svc:paws-preview-1", "svc:paws-preview-2"],
      "ip": ["tcp:443"]
    }
  ]
}
```

The runner advertises `tailscale serve --service=svc:<name> --https=443 http://127.0.0.1:<port>`, waits for HTTPS to answer so the certificate is ready, and clears it with `tailscale serve clear svc:<name>` during cleanup. Services run in background mode automatically. Paws never proxies the app. Each service has its own origin. Serve is tailnet-only; do not configure Funnel or public ingress for a preview.

The issue page offers desktop, tablet and phone widths, Reload, and Open in new tab. If the app's response refuses framing through X-Frame-Options or CSP frame-ancestors, only the new-tab link is shown. Accept still happens in the authenticated Paws dashboard, never through identity headers on the preview.

Confirm the policy with a member browser and with a device outside the tailnet: the member can open the service URL and the outside device cannot. Automated tests use a fake Tailscale runtime; they do not validate a deployed tailnet's ACL policy.

## Tailscale API credentials

Service definitions and tailnet ACL grants currently use the manual setup above. [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) documents API operations for listing, updating and deleting services and for host approval. [Trust credentials](https://tailscale.com/docs/reference/trust-credentials) documents scoped credentials; [OAuth clients](https://tailscale.com/docs/features/oauth-clients) describes the client-credentials flow. A future reconciler should use service, auth-key and policy scopes only as needed, keep its OAuth client secret under `~/.paws/secrets`, and never distribute it to agents or runners. The current feature does not consume an OAuth credential or change the tailnet policy automatically.
