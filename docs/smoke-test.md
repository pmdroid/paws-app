# Local smoke test

This is the real-machine run. The default path is GitHub issues on `pmdroid/paws-demo`: three sub-issues, three merged pull requests in blocked-by order, one answered question, and one Closeout fix loop.

Run it on the developer machine that has a Codex login for review, and an implementer login for Claude Code, Grok, or Codex. Sign-in for GitHub is the OAuth device flow in [GitHub sign-in](github-login.md). Triggers and comments are in [GitHub issues](github-issues.md).

Paws does not read agent credential files. For Grok it calls `authenticate` with the advertised method id only (`cached_token`, or `xai.api_key` when `agents.grok.allow_api_key` is true and `XAI_API_KEY` is set). It does not read `~/.grok/auth.json` or the key value.

The Linear comment-mode run is [optional](#optional-linear) and comes after the GitHub run. Its automated stand-in is `test/loop.e2e.test.ts` (comment mode, `gh` auth, the three-item `examples/paws-demo` epic, one comment answer, one Closeout fix, no webhook and no tunnel). Nothing in that test calls the network.

## Prerequisite

The smoke run uses Pascal's OAuth App. Put that client id in `github.oauth_client_id` or `PAWS_GITHUB_CLIENT_ID` before setup. An empty or placeholder id stops before GitHub is called. Registering a different app is in [GitHub sign-in](github-login.md).

Closeout is the in-process engine. `origin/main` needs a `.agents/closeout.yaml` that loads. Setup can write a starter policy in the checkout; commit it before `doctor` and `bun run paws`.

## 1. Install

```sh
bun install
```

Bun 1.4.2 or newer. `git` and `gh` on `PATH`. `gh` is for the template push and for creating the epic issues. The Paws process itself uses the OAuth token.

## 2. Push the template

From `examples/paws-demo`, with `gh` already logged in:

```sh
./scripts/push-template.sh --yes
```

That creates `pmdroid/paws-demo` when it is missing and force-pushes `main`. Override the destination with `PAWS_DEMO_REPO=owner/paws-demo`. The repository name must be `paws-demo`. The script pushes with `gh auth token`, through a one-shot credential helper.

## 3. Setup

From the Paws repository root:

```sh
bun run paws setup
```

Setup runs the GitHub device flow (a code, approved at [github.com/login/device](https://github.com/login/device)), asks which repository to use (`pmdroid/paws-demo`), leaves the tracker on `github`, and asks for the implementer (`claude`, `grok`, or `codex`). It writes `~/.paws/config.toml` and can write a starter `.agents/closeout.yaml` in the checkout. The keys that matter:

```toml
[github]
auth = "oauth"
oauth_client_id = "<Pascal's OAuth App client id>"
repo = "pmdroid/paws-demo"

[tracker]
kind = "github"

[tracker.github]
trigger_label = "paws"
mention = "@paws"
trusted = ["OWNER", "MEMBER", "COLLABORATOR"]
repos = ["pmdroid/paws-demo"]

[tracker.github.status_labels]
running = "paws:running"
awaiting_input = "paws:awaiting-input"
done = "paws:done"

[agents]
implementer = "claude"
```

`agents.implementer` is whichever of `claude`, `grok`, or `codex` you choose. There is no webhook URL and no GitHub App. Codex stays the reviewer (`codex login`). Setup prints the implementer login command and does not run it.

On a machine without Claude Code, the prompt lists grok (the pinned `@xai-official/grok` on `node_modules/.bin`, unless `agents.grok.path` points at another `grok`):

```text
Choose the implementer Paws will run. Only installed, loginable agents are listed.
  1) grok: Run `grok login`
  2) codex: Run `codex login`
```

Type `grok` or `1`. Paws writes `agents.implementer = "grok"` and prints:

```text
Run `grok login`
```

`grok login` opens a browser and caches the session at `~/.grok/auth.json`. Paws never reads that file. Headless and Docker logins use device auth into the agent-home volume:

```sh
grok login --device-auth
```

Mount the agent home so that file persists, then run `grok login --device-auth` inside the container. The next `grok agent stdio` advertises `cached_token`.

`XAI_API_KEY` is an alternative only when `agents.grok.allow_api_key` is true. Leave that false unless you mean to pass the key into the Grok process. Paws still does not print the key. Paws strips `XAI_API_KEY` (unless `allow_api_key` is true), `GITHUB_TOKEN`, `GH_TOKEN`, `SSH_AUTH_SOCK`, and cloud keys out of the agent environment.

Grok is spawned as `grok --no-auto-update agent stdio --no-leader` with the worktree as its cwd. Paws does not pass `--always-approve` or `--yolo`. Tool permission stays on the `session/request_permission` guard.

`--yes` skips the implementer menu and keeps Claude as the implementer. The device-flow approval still has to happen when no token is stored. Pass `--implementer grok` to select Grok without the prompt.

## 4. Doctor

```sh
bun run paws doctor
```

Every required line must be `ok`, and the command exits `0`. A `missing` line names the check and prints one `fix:` line. For the GitHub tracker those checks cover git, Bun, the home directory, GitHub sign-in, push access to `github.repo`, the implementer, Codex, Closeout, and the checkout. A missing sign-in tells you to run `bun run paws login github`. The Closeout line is `policy loads on origin/main`. A missing or malformed `.agents/closeout.yaml` prints one fix line. When `agents.implementer` is `grok`, a missing Claude install is a `note` and does not fail the command. If Grok advertises no auth method, doctor prints one actionable line:

```text
missing grok: Run `grok login`
```

Doctor does not print the OAuth token or any key. Webhook, public URL, and GitHub App checks stay off this list unless those modes are turned on.

## 5. Start

```sh
bun run paws
```

Expect:

```text
paws ready · http://127.0.0.1:8787
dashboard http://127.0.0.1:8787/status
```

The process listens only on `127.0.0.1`. `GET /health` returns JSON. `GET /api/status` is the live snapshot (`source: "live"`). The dashboard has a **Sign in with GitHub** button when no token is stored. There is no tunnel line.

## 6. Epic with three sub-issues

From the Paws repository root, after the template push. This creates the parent **Export rows**, three sub-issues whose titles and bodies come from `examples/paws-demo/epic/epic.json`, blocked-by edges in that file's order, and the `paws` label on the parent only after the children exist.

```sh
REPO="${PAWS_DEMO_REPO:-pmdroid/paws-demo}" bun - <<'BUN'
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.env.REPO ?? "pmdroid/paws-demo";
const epic = await Bun.file("examples/paws-demo/epic/epic.json").json();
const dir = mkdtempSync(join(tmpdir(), "paws-epic-"));

function gh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "gh failed").trim();
    throw new Error(detail);
  }
  return (result.stdout ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .pop();
}

function issueNumber(url) {
  const match = /(\d+)$/.exec(url);
  if (!match) throw new Error(`not an issue url: ${url}`);
  return match[1];
}

gh([
  "label",
  "create",
  "paws",
  "--repo",
  repo,
  "--description",
  "Hand this issue to Paws",
  "--force",
]);

const parentBody = [
  "Delegate this parent to Paws. Three sub-issues merge in order with no manual git.",
  "",
  "1. Fix the seeded export test. Closeout fails once, then the fix loop repairs exportRows.",
  "2. Add a header helper in the same file. Blocked by the export fix.",
  "3. Call ask_team before choosing whether archived rows are included.",
  "",
  "The acceptance target is three merged pull requests, one answered question, and one fix loop.",
].join("\n");
const parentFile = join(dir, "parent.md");
writeFileSync(parentFile, `${parentBody}\n`);
const parentUrl = gh([
  "issue",
  "create",
  "--repo",
  repo,
  "--title",
  epic.parent.title,
  "--body-file",
  parentFile,
]);
if (!parentUrl) throw new Error("gh issue create returned no url");
const parent = issueNumber(parentUrl);

const numbers = new Map();
for (const child of epic.children) {
  const bodyFile = join(dir, `${child.slug}.md`);
  writeFileSync(bodyFile, `${child.description}\n`);
  const args = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    child.title,
    "--body-file",
    bodyFile,
    "--parent",
    parent,
  ];
  for (const slug of child.blockedBy ?? []) {
    const blocker = numbers.get(slug);
    if (!blocker) throw new Error(`missing blocker ${slug}`);
    args.push("--blocked-by", blocker);
  }
  const childUrl = gh(args);
  if (!childUrl) throw new Error(`gh issue create returned no url for ${child.slug}`);
  const number = issueNumber(childUrl);
  numbers.set(child.slug, number);
  console.log(`${child.slug} #${number}`);
}

gh(["issue", "edit", parent, "--repo", repo, "--add-label", "paws"]);
console.log(`parent #${parent} labeled paws`);
rmSync(dir, { recursive: true, force: true });
BUN
```

The three children, in blocked-by order:

1. **Fix `exportRows`** — Closeout fails once on the seeded `src/export.test.ts`, the fix loop repairs `exportRows`, then the pull request squash-merges. Body starts with `Closes #<that issue>`.
2. **Add `exportWithHeader`** — stays queued until the first pull request merges, then opens and squash-merges. Same `Closes #<n>` line for its own issue.
3. **Archived rows** — calls `ask_team` with "Include archived rows?" and options `yes` and `no`.

Watch the issue comments (each status comment starts with `Paws:`):

1. On the parent: `Picked up 3 sub-issues` and the three issue numbers in blocked-by order.
2. The first child goes to `paws:running`. Closeout fails once, the implementer commits a fix, Closeout accepts, a pull request opens with `Closes #<n>` on the first line, and Paws squash-merges it. The child ends on `paws:done`.
3. The second child opens and merges after the first.
4. The third child parks on a question comment and the label `paws:awaiting-input`. The comment lists `yes` and `no` and ends with `<!-- paws:q:<id> -->`. Reply in that thread with `yes` or `no`, or with your own words. The first reply that does not start with `Paws:` is the answer.
5. The third pull request merges. The parent gets `Epic complete.` and Paws closes it.

Stop with a comment whose line is `/paws stop`. That cancels the live run.

Data stays in `~/.paws` (`paws.db`, `worktrees/`, `runs/<identifier>/` for the Closeout verdict). Shut down with Ctrl-C.

## Optional: Linear

[Comment mode](linear-modes.md) is the Linear path. Run setup again and choose the `linear` tracker. Setup asks for a Linear personal API key and the team, writes `[tracker] kind = "linear"` and `[linear] mode = "comments"`, and keeps GitHub for pull requests. Comment mode uses no webhook URL and no public URL.

Reset the demo epic from a checkout of this repository:

```sh
./examples/paws-demo/scripts/push-template.sh --yes
LINEAR_API_KEY=lin_api_... bun scripts/demo-reset.ts --yes
```

`LINEAR_ACCESS_TOKEN` is accepted when `LINEAR_API_KEY` is unset. Optional: `PAWS_DEMO_TEAM` (Linear team key, default `ENG`) and `PAWS_DEMO_REPO`.

The parent is **Export rows**. The three sub-issues merge in `blocks` order:

1. **ENG-2** — fix `exportRows`. Closeout fails once, the fix loop repairs it, then the pull request squash-merges.
2. **ENG-3** — add `exportWithHeader`. Stays queued until ENG-2 merges.
3. **ENG-4** — calls `ask_team` with "Include archived rows?" and options `yes` and `no`.

Label the parent `paws` (setup creates the label) or delegate it to the Linear user in `config.toml`.

Watch the issue comments (each one starts with `Paws:`):

1. `Picked up 3 sub-issues; order: ENG-2 → ENG-3 → ENG-4`.
2. ENG-2 fails Closeout once, the implementer commits a fix, Closeout accepts, a pull request opens (`Fixes ENG-2` on the first line, `Fix attempts: 1` in the body), and Paws squash-merges it.
3. ENG-3 opens and merges after ENG-2.
4. ENG-4 parks on a question comment. Reply in that thread with `yes` or `no`, or with your own words. The run continues with that answer.
5. ENG-4 merges. The thread gets `Epic complete.`

When the tracker is Linear and the implementer is Claude, doctor includes `git`, `bun`, `home`, `linear`, `linear-mode`, `linear-team`, `linear-label`, `gh-login`, `gh-push`, `claude-acp`, `codex-acp`, `claude`, `codex`, `closeout`, and `repository`. `linear-webhook`, `public-url`, `ngrok`, and `github-app` appear only when webhooks or GitHub App auth are turned on.

### Linear agent sessions

Create a Linear OAuth application named Paws. Register `http://localhost:3000/oauth/callback` as its redirect URI. Enable webhooks, select **Agent session events**, and set the webhook URL to `https://YOUR-NGROK-DOMAIN/webhooks/linear`.

Run:

```sh
bun run paws setup --tracker linear --linear-mode agent-session
```

Enter the application's client ID and client secret. Open the authorization link printed by setup and approve the installation as a workspace admin. Setup listens on loopback port 3000, verifies the returned state, exchanges the code, and stores the access token, refresh token, and expiry under `~/.paws/secrets/`. The callback listener closes when authorization completes.

Configure ngrok authentication, set `LINEAR_WEBHOOK_SECRET` to the application's webhook signing secret, and run these commands in the same shell:

```sh
export LINEAR_WEBHOOKS=true
export PAWS_PUBLIC_URL=https://YOUR-NGROK-DOMAIN
bun run paws doctor
bun run paws
```

Paws starts the ngrok tunnel for that domain. Delegate the parent issue to Paws in Linear to start an agent session.

## Docker

Docker is optional. `bun run paws --docker` runs the adapters in the sandbox. One-time container login is `bun run paws login claude --docker` and `bun run paws login codex --docker`. For Grok, run `grok login --device-auth` inside the container with the agent-home volume mounted so `cached_token` survives. The default run stays on the host.
