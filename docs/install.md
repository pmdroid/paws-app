# Install Paws

`paws install` configures the control plane on a Linux host with a systemd user manager. Work runs on paired runners. Run the installer as the user who will own the Paws service.

## Prepare the host

Install Git, OpenSSL and Bun 1.4.2. If you use mise:

```sh
mise use -g bun@1.4.2
```

Clone this repository into the directory you will keep for the service, then install dependencies and build the dashboard:

```sh
git clone https://github.com/pmdroid/paws-app.git ~/.local/share/paws/app
cd ~/.local/share/paws/app
bun install --frozen-lockfile
bun run build:status
```

Choose the HTTPS origin people will use to reach Paws. Configure the Linear OAuth app's callbacks and GitHub App as described in [Workspace access](workspace-access.md) and [GitHub App](github-app.md).

## Configure the service and TLS

```sh
bun run paws install
```

The installer asks for the checkout, Paws home, listener address and port, public HTTPS URL, runner listener, Linear team and repositories. Press Enter to keep the displayed value. Type `-` to clear an optional value. It also asks for optional exe.dev runner VM size settings.

The installer writes:

- `~/.paws/https.env`, with mode `0600`, for the service environment.
- `~/.paws/config.toml`, with the team, repositories and optional VM size settings.
- `~/.config/systemd/user/paws.service` and its working-directory drop-in.

Custom Paws homes and `XDG_CONFIG_HOME` change these locations. Re-running the installer keeps current values and unrelated configuration keys.

For a public dashboard, supply a certificate and private key that cover the configured hostname. The installer validates the pair before it continues. For a `*.ts.net` origin, it offers `tailscale cert` and installs a weekly `paws-tls-renew.timer`. This needs HTTPS certificates enabled in the tailnet and permission for your user to fetch them. The installer prints commands to fix a failed fetch and accepts existing certificate paths instead. Keep the private key at mode `0600` or `0400`. See [Configuration](configuration.md) for renewal details.

When the runner listener is configured, it uses the same server certificate. The installer prints the dashboard and runner ports to allow in your tailnet policy. It initializes the runner authority and command signing key under `PAWS_HOME/secrets/runner-identity` if that directory is absent. An existing authority stays in place so enrolled runners keep their trust.

The installer reloads the systemd user units and runs doctor. Each missing check includes its fix when one is available. Workspace access, repository access and agent sign-in can remain missing until you finish setup in the dashboard.

Answer **no**, the default, to the service startup question on this first pass so you can configure secrets next.

## Add secrets

```sh
bun run paws install secrets
```

This separate command stores the GitHub App and Linear credentials, webhook secrets and optional provider secrets. Secret input is hidden. Generated secrets appear once on the controlling terminal. An empty answer keeps an existing value. The command uses the installed service's env file; use `--env-file PATH` to select another file. See [Configuration](configuration.md) for the prompts and credential storage.

## Start Paws

Run the installer again and answer **yes** to enable and start the service and enable linger. You can also provide consent explicitly:

```sh
bun run paws install --start-service yes
```

The installer runs `loginctl enable-linger` for the current user so the service can run without a login session, then `systemctl --user enable --now paws.service`. It waits up to about 30 seconds for `/health` to return a healthy report. Public dashboards use the configured HTTPS origin; local dashboards use the listener address and port. A failed command or health timeout returns a nonzero exit code. Inspect the service with:

```sh
journalctl --user -u paws.service -n 100
```

Without consent, the installer leaves startup to you. Certificate renewal may still be enabled when you accepted managed tailnet certificates.

## Finish in the dashboard

The installer prints links with your configured public URL:

1. Sign in as a Linear workspace admin at `<public URL>/auth/linear/install`.
2. Connect GitHub in Integrations at `<public URL>/status/settings/integrations`, then choose repositories and Linear teams.
3. Open `<public URL>/status/runners` to pair the first runner or choose **Create VM**. VM creation needs the provider credentials from the secrets step. Follow [Enroll a remote Linux runner](runner-enrollment.md) to add your own host and sign in to its agents.

Paws starts work only after a workspace admin has signed in. Run doctor again with the service environment loaded and follow any remaining fixes. See [Smoke test](smoke-test.md) for a real delegated run.

## Unattended configuration

Use `bun run paws install --help` for all keys. `--non-interactive` uses defaults and existing values, and rejects invalid input without asking. An answers TOML file uses underscore keys; command flags use hyphens and override the file. Secrets remain in the separate secrets step.

```toml
checkout = "~/.local/share/paws/app"
paws_home = "~/.paws"
paws_host = "0.0.0.0"
paws_port = "8787"
paws_public_url = "https://paws.example.com"
paws_runner_host = "0.0.0.0"
tls_key_path = "/path/to/paws.key"
tls_cert_path = "/path/to/paws.crt"
start_service = "no"
```

```sh
bun run paws install --non-interactive --answers /path/to/answers.toml
```

Leave `start_service` unset or set it to `"no"` to skip startup. Set it to `"yes"` only when the service is ready to start.
