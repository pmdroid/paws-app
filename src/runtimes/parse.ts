import { journalCaught } from "../journal";
/**
 * A task repository's runtime list, read from its mise config on `origin/main`.
 *
 * Only the tool list leaves this module. `[env]`, `[hooks]`, `[tasks]`,
 * `[settings]`, `[plugins]`, tool options such as `postinstall`, and any
 * templated value are dropped. Every mise backend is carried, and backends such as
 * `npm:`, `cargo:`, `pipx:` and `go:` run that package's own build or install steps on the runner.
 */

/** One runtime the runner installs with mise, such as `{ tool: "node", version: "22" }`. */
export type Runtime = { tool: string; version: string };

/** `notices` are lines for the task's Linear session, one per refused tool or unreadable file. */
export type RuntimeList = { runtimes: Runtime[]; notices: string[] };

/** Repository-root files Paws reads, highest precedence first. */
export const RUNTIME_FILES = ["mise.toml", ".mise.toml", ".tool-versions"] as const;

/** mise core tools. `core:` and asdf aliases resolve to these names. */
export const CORE_RUNTIME_TOOLS = [
  "node",
  "python",
  "go",
  "java",
  "ruby",
  "rust",
  "bun",
  "deno",
] as const;

/** Most runtimes one task may ask for. */
export const RUNTIME_LIMIT = 32;

/** asdf names that mise maps to its core tools. */
const ALIASES: Record<string, string> = { nodejs: "node", golang: "go" };
/**
 * Any mise tool: a registry short name such as `uv`, or `backend:name` such as `npm:prettier`,
 * `cargo:ripgrep` or `go:github.com/owner/repo/cmd/x`. It cannot start with `-`, and it holds no
 * spaces, quotes, brackets or `=` that mise would read as options.
 */
export const RUNTIME_TOOL = /^(?:[a-z][a-z0-9-]{0,31}:)?[A-Za-z0-9@][A-Za-z0-9@._/+-]{0,199}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

type Entry = { tool: string; versions: unknown[] };

/**
 * The runtime list from the files Paws read at the repository root. `files`
 * maps a name in {@link RUNTIME_FILES} to its bytes. Each tool comes from the
 * highest-precedence file that names it.
 */
export function parseRuntimeFiles(files: ReadonlyMap<string, Uint8Array>): RuntimeList {
  const notices: string[] = [];
  const chosen = new Map<string, Runtime[]>();
  for (const name of RUNTIME_FILES) {
    const bytes = files.get(name);
    if (bytes === undefined) continue;
    const text = decode(bytes);
    const entries =
      text === undefined
        ? undefined
        : name === ".tool-versions"
          ? toolVersions(text)
          : miseToml(text);
    if (entries === undefined) {
      notices.push(
        `Paws could not parse ${name} on origin/main, so it installs no runtimes from it.`,
      );
      continue;
    }
    for (const entry of entries) {
      const tool = allowedTool(entry.tool);
      if (tool === undefined) {
        notices.push(
          `Paws refused the mise tool ${quote(entry.tool)} in ${name}: it is not a mise tool name.`,
        );
        continue;
      }
      if (chosen.has(tool)) continue;
      const versions: Runtime[] = [];
      for (const value of entry.versions) {
        const version = plainVersion(value);
        if (version === undefined) {
          notices.push(
            `Paws refused the mise tool ${quote(tool)} in ${name}: its version is not a plain version string.`,
          );
          versions.length = 0;
          break;
        }
        if (!versions.some((runtime) => runtime.version === version))
          versions.push({ tool, version });
      }
      if (versions.length) chosen.set(tool, versions);
    }
  }
  const runtimes = [...chosen.values()].flat();
  if (runtimes.length > RUNTIME_LIMIT) {
    notices.push(
      `Paws installs at most ${RUNTIME_LIMIT} runtimes and skipped ${runtimes
        .slice(RUNTIME_LIMIT)
        .map((runtime) => quote(runtime.tool))
        .join(", ")}.`,
    );
    runtimes.length = RUNTIME_LIMIT;
  }
  return { runtimes, notices };
}

/** The `[tools]` table of a mise TOML file, or `undefined` when the file does not parse. */
function miseToml(text: string): Entry[] | undefined {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (caughtError1) {
    journalCaught(caughtError1, "parse.miseToml.parse", null);
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const tools = parsed.tools;
  if (tools === undefined) return [];
  if (!isRecord(tools)) return undefined;
  return Object.entries(tools).map(([tool, value]) => ({
    tool,
    versions: Array.isArray(value) ? value : [value],
  }));
}

/** `.tool-versions` lines: `tool version [version...]`, with `#` comments. */
function toolVersions(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [tool, ...versions] = line.split(/\s+/);
    entries.push({ tool: tool!, versions });
  }
  return entries;
}

function allowedTool(name: string): string | undefined {
  const bare = name.startsWith("core:") ? name.slice("core:".length) : name;
  const tool = ALIASES[bare] ?? bare;
  if ((CORE_RUNTIME_TOOLS as readonly string[]).includes(tool)) return tool;
  return RUNTIME_TOOL.test(name) ? name : undefined;
}

/** A version string, or the `version` of a tool table. Tool options are dropped. */
function plainVersion(value: unknown): string | undefined {
  const version = isRecord(value) ? value.version : value;
  return typeof version === "string" && VERSION.test(version) ? version : undefined;
}

function decode(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (caughtError2) {
    journalCaught(caughtError2, "parse.decode", null);
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A tool name for a Linear line, without control characters and at most 100 characters. */
function quote(tool: string): string {
  const clean = tool.replace(/[\p{Cc}`]/gu, "").slice(0, 100);
  return `\`${clean || "?"}\``;
}
