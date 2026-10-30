# Declare a repository's runtimes

A task repository names the runtimes it needs, such as Node or Python, in its own mise config. Before the agent starts, the runner installs them with the `mise` binary it ships. The agent, the reviewer, and every Closeout setup step and check then find them on `PATH`.

The runner's own Bun is not on a task's `PATH`. A repository whose checks run `bun` declares it like any other runtime.

## Write the config

Commit one of these files at the repository root on `main`:

```toml
# mise.toml
[tools]
node = "22"
python = "3.12"
```

```text
# .tool-versions
node 22
python 3.12
```

Paws reads `mise.toml`, `.mise.toml`, and `.tool-versions`, in that order of precedence. When two files name the same tool, the first file in that order wins. Files in subdirectories and your global mise config are not read.

Paws reads these files from `origin/main`, the same way it reads `.agents/closeout.yaml`. Changing them on a task branch has no effect until that change merges. Each file may be at most 64 KiB.

## Tools and backends

Paws carries any mise tool: a registry short name such as `uv`, `ruff` or `golangci-lint`, a core tool such as `node`, or a `backend:name` entry such as `aqua:cli/cli`, `npm:prettier`, `cargo:ripgrep`, `pipx:black` or `go:github.com/owner/repo/cmd/tool`. `nodejs` and `golang` are accepted as aliases, and core tools may be written with a `core:` prefix, such as `"core:node"`.

A tool name cannot start with `-` and may contain only letters, digits and `@ . _ / + -` after its optional `backend:` prefix. Any other name is refused, installs nothing, and leaves one line in the task's Linear session. The rest of the list still installs.

Backends such as `npm:`, `cargo:`, `pipx:` and `go:` build or install the package with its own scripts on the runner, in the runtime cache every task on that runner shares. They need their toolchain: list `node`, `rust`, `python` or `go` before them in the same config, and Paws puts each runtime it has installed on `PATH` for the installs after it.

Runners before 0.1.52 accept only core tools and `aqua:` tools. Paws sends those runners only that part of the list and says in Linear which tools it held back.

## Versions

A version is a plain string of letters, digits, and `.`, `_`, `+`, or `-`, up to 64 characters. A prefix such as `"22"` installs the newest matching release, and `"lts"` or `"latest"` work as mise defines them. A tool may list several versions, such as `python = ["3.12", "3.11"]`. The first one comes first on `PATH`.

In a tool table only `version` is read, so `node = { version = "22" }` works. Other tool options such as `postinstall` are dropped. A version that is not a plain string refuses that tool.

A task installs at most 32 runtimes. Paws skips the rest and says so in Linear.

## What Paws ignores

Paws sends the runner only the tool and version list, never the file. `[env]`, `[hooks]`, `[tasks]`, `[settings]`, `[plugins]`, and templated values do not run. mise on the runner reads no repository or global config. The task's `PATH` gets each version's own `bin` folder, not mise shims.

## On the runner

Runtimes go into a cache under the agent's home in `/var/lib/paws-agent`, shared by every task on that runner. Each version installs once and later tasks reuse it. Tasks on the same runner take turns installing.

An install that fails, or runs longer than ten minutes, fails the task. Its Linear session names the runtime and gives mise's last line of output. A successful install posts one line with the runtimes and how long they took.

The runner's card under **Runners** lists each runtime it has installed, with its version as the config wrote it. A failed install shows **Install failed** and the reason. Older runner releases do not report runtimes, so their cards list none.

## Check it end to end

[Smoke test](smoke-test.md#runtimes) runs a Node 22 and Python 3.12 repository from delegation to merge.
