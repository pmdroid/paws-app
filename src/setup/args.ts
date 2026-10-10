import { stop } from "./stop";

export type LinearModeFlag = "comments" | "agent-session";

export type TrackerFlag = "github" | "linear" | "both";

export type SetupFlags = {
  help: boolean;
  yes: boolean;
  home: string | null;
  tracker: TrackerFlag | null;
  checkout: string | null;
  repo: string | null;
  linearMode: LinearModeFlag | null;
  linearApiKey: string | null;
  linearTeam: string | null;
  linearClientId: string | null;
  linearClientSecret: string | null;
  linearAccessToken: string | null;
  linearRefreshToken: string | null;
  closeoutPath: string | null;
  implementer: "claude" | "grok" | "codex" | null;
};

const VALUE_FLAGS = {
  "--home": "home",
  "--tracker": "tracker",
  "--checkout": "checkout",
  "--repo": "repo",
  "--linear-mode": "linearMode",
  "--linear-api-key": "linearApiKey",
  "--linear-team": "linearTeam",
  "--linear-client-id": "linearClientId",
  "--linear-client-secret": "linearClientSecret",
  "--linear-access-token": "linearAccessToken",
  "--linear-refresh-token": "linearRefreshToken",
  "--closeout-path": "closeoutPath",
  "--implementer": "implementer",
} as const;

type ValueKey = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];

export function parseArgs(argv: readonly string[]): SetupFlags {
  const args = argv[0] === "setup" ? argv.slice(1) : [...argv];
  const flags: SetupFlags = {
    help: false,
    yes: false,
    home: null,
    tracker: null,
    checkout: null,
    repo: null,
    linearMode: null,
    linearApiKey: null,
    linearTeam: null,
    linearClientId: null,
    linearClientSecret: null,
    linearAccessToken: null,
    linearRefreshToken: null,
    closeoutPath: null,
    implementer: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || token.length === 0) continue;
    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (token === "--yes" || token === "-y") {
      flags.yes = true;
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const key = VALUE_FLAGS[name as keyof typeof VALUE_FLAGS];
    if (key === undefined) stop(`Unknown setup flag ${name}.`);
    const value = inline ?? args[index + 1];
    if (value === undefined || (inline === null && value.startsWith("--"))) {
      stop(`${name} needs a value.`);
    }
    if (inline === null) index += 1;
    assign(flags, key, value);
  }
  return flags;
}

export const HELP = [
  "paws setup",
  "  --yes                        non-interactive; missing answers exit",
  "  --tracker github|linear|both GitHub is the default; linear keeps the previous setup",
  "  --home DIR                   ~/.paws directory (or PAWS_HOME)",
  "  --checkout DIR               local clone used to infer owner/repo",
  "  --repo OWNER/REPO            GitHub repository you can push to",
  "  --linear-mode comments|agent comment mode is the default",
  "  --linear-api-key KEY         personal API key for comment mode",
  "  --linear-team KEY            Linear team key or id",
  "  --linear-client-id ID        OAuth client id for agent mode",
  "  --linear-client-secret SECRET",
  "  --linear-access-token TOKEN",
  "  --linear-refresh-token TOKEN",
  "  --closeout-path PATH         local closeout binary (no release assets yet)",
  "  --implementer claude|grok|codex",
  "                               who implements; omit it to choose from installed agents",
].join("\n");

function assign(flags: SetupFlags, key: ValueKey, value: string): void {
  if (key === "linearMode") {
    flags.linearMode = parseMode(value);
    return;
  }
  if (key === "tracker") {
    flags.tracker = parseTracker(value);
    return;
  }
  if (key === "implementer") {
    flags.implementer = parseImplementer(value);
    return;
  }
  flags[key] = value;
}

function parseTracker(value: string): "github" | "linear" | "both" {
  if (value === "github" || value === "linear" || value === "both") return value;
  stop("Pass --tracker as github, linear, or both.");
}

function parseMode(value: string): LinearModeFlag {
  if (value === "comments") return "comments";
  if (value === "agent" || value === "agent-session") return "agent-session";
  stop("Pass --linear-mode as comments or agent.");
}

function parseImplementer(value: string): "claude" | "grok" | "codex" {
  if (value === "claude" || value === "grok" || value === "codex") return value;
  stop("Pass --implementer as claude, grok, or codex.");
}
