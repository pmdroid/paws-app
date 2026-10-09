# Docker sandbox

Optional isolation for the ACP agent. It is **off** unless a caller passes a `docker` option to `spawnAgent`. Without that option the host spawn is unchanged: same command, args, environment, detached process group, and stdio pipes. QM-20 wires the flag. This module does not turn the option on from `src/index.ts`.

## What the container gets

`buildDockerRun` / `spawnAgent(..., { docker })` builds:

- `--network none`. The namespace has loopback only, so there is no route to the host, the LAN, or the internet.
- `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, and `https_proxy` set to the allow-list proxy. That proxy dials vendor APIs (Anthropic, OpenAI) and package registries (npm, PyPI, crates, Go, Maven, RubyGems, GitHub release/codeload hosts) on ports 80 and 443, and refuses everything else. With `--network none` the agent process cannot open that route; direct egress is impossible.
- One bind mount: the item worktree, at the same absolute path the ACP session uses as `cwd`.
- One named volume: `paws-claude-auth` or `paws-codex-auth`, mounted at `/paws-auth`. That volume is the container login. It is not the host home.
- Container `HOME=/paws-auth`. The host `$HOME` is not passed to the docker client or the container.
- No `SSH_AUTH_SOCK`, no SSH agent mount, no `/var/run/docker.sock`, no API tokens in the docker client environment or in `--env`.

The docker client itself is started with a scrubbed environment (`PATH` and locale only).

## One-time login

Claude Code on macOS keeps the login in the Keychain. A container cannot read that. Codex and Claude logins on the host are also outside the container. Container mode needs a separate login into a Docker volume:

```sh
paws login claude --docker   # loginDocker("claude")
paws login codex --docker    # loginDocker("codex")
```

`loginDocker` creates the named volume and runs `claude auth login` or `codex login` inside the image. The login container uses the Docker bridge and the allow-list proxy (`host.docker.internal`) so the CLI can reach the vendor. It still does not mount the worktree, `$HOME`, the SSH agent, or the Docker socket.

The image default is `paws-sandbox:local` (`PAWS_SANDBOX_IMAGE` overrides it). It needs `sh`, and for a real run the `claude` / `codex` CLIs plus `claude-agent-acp` / `codex-acp`. Example:

```Dockerfile
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Install the Claude and Codex CLIs and the ACP adapters you already trust.
```

## Manual check

The probe must find no host credentials. Docker has to be running, and the image has to contain `sh`.

```sh
bun src/sandbox/probe-cli.ts /absolute/path/to/worktree
```

The worktree should be the item worktree (or any directory that is not your home, `~/.ssh`, or the Docker socket). Stdout must be exactly:

```text
probe ok: no host credentials
```

That process checks, inside the container:

- token and cloud-key variables are unset (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, and the rest of the list in `CREDENTIAL_PROBE_SCRIPT`)
- `SSH_AUTH_SOCK` and `SSH_AGENT_PID` are unset
- `/var/run/docker.sock` and `/run/docker.sock` are not sockets
- `HOME` is `/paws-auth`, not the host home
- `/proc/self/mountinfo` does not mention `docker.sock`, `/.ssh`, or `Keychains`

Anything else prints `probe failed: host credentials visible` and exits non-zero. Stderr prints the `docker run` argv first: one `type=bind` mount (the worktree), one `type=volume` mount (the login volume), `--network none`, and the proxy `--env` lines. The host home, the SSH socket, and `docker.sock` are not in that argv.
