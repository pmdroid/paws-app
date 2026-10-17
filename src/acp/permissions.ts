import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface GuardContext {
  hostAccess?: boolean;
  worktree: string;
  home: string;
  pawsRoot: string;
  skillRoots?: readonly string[];
}

export interface PermissionSubject {
  kind?: string | null;
  name?: string | null;
  title?: string | null;
  locations?: Array<{ path: string } | null> | null;
  rawInput?: unknown;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
}

export interface GuardDecision {
  allow: boolean;
  reason: string;
}

type PathClass = { kind: "inside" } | { kind: "denied"; reason: string };

const NETWORK_BINS = new Set(["curl", "wget", "ssh", "scp", "sftp", "nc", "netcat", "telnet"]);
const PACKAGE_MANAGERS = new Set([
  "npm",
  "npx",
  "bun",
  "bunx",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "cargo",
]);
const COMMAND_KEYS = new Set(["command", "cmd", "script"]);

export function isInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function decidePermission(subject: PermissionSubject, ctx: GuardContext): GuardDecision {
  if (ctx.hostAccess) return { allow: true, reason: "runner user access" };
  if (subject.kind === "think" || subject.kind === "switch_mode") {
    return { allow: true, reason: "no filesystem or command side effects" };
  }
  if (
    subject.name === "ask_team" ||
    subject.name === "update_plan" ||
    subject.name === "open_pull_request" ||
    subject.name === "get_closeout" ||
    subject.name === "run_closeout"
  ) {
    return { allow: true, reason: `${subject.name} is handled by the injected hook` };
  }

  const command = commandText(subject);
  const paths = collectPaths(subject, command);

  const denied = command ? deniedCommandReason(command) : undefined;
  if (denied) return { allow: false, reason: denied };

  if (command && /:\/\//.test(command) && !isPackageManager(command)) {
    return { allow: false, reason: "network access is denied" };
  }
  if (subject.kind === "fetch" && !isPackageManager(command)) {
    return { allow: false, reason: "network tools are denied" };
  }

  if (subject.cwd) {
    const cwd = classifyPath(subject.cwd, ctx);
    if (cwd.kind === "denied") return { allow: false, reason: cwd.reason };
  }

  const resources = localSkillCommandPaths(subject, ctx);
  if (command && !resources.length && ctx.skillRoots?.some((root) => command.includes(root)))
    return { allow: false, reason: "local skills allow only direct scripts and resource reads" };
  for (const path of paths) {
    if (isLocalSkillPath(path, ctx)) {
      if (subject.kind === "read" && !command) continue;
      if (resources.includes(lexicalPath(path, ctx))) continue;
    }
    const classified = classifyPath(path, ctx);
    if (classified.kind === "denied") return { allow: false, reason: classified.reason };
  }

  const fileKind =
    subject.kind === "read" ||
    subject.kind === "edit" ||
    subject.kind === "delete" ||
    subject.kind === "move";
  if (fileKind && paths.length === 0) {
    return { allow: false, reason: "file tool did not name a path inside the worktree" };
  }

  if ((subject.kind === "execute" || command) && !command.trim()) {
    return { allow: false, reason: "command was empty" };
  }

  if (!command && paths.length === 0 && subject.kind !== "search") {
    return { allow: false, reason: "tool call did not identify an in-worktree path or command" };
  }

  return { allow: true, reason: "inside the worktree" };
}

export function isLocalSkillPath(input: string, ctx: GuardContext): boolean {
  const candidate = lexicalPath(input, ctx);
  return (ctx.skillRoots ?? []).some((root) => {
    if (!isInside(root, candidate)) return false;
    try {
      return isInside(root, realpathSync(candidate));
    } catch {
      return false;
    }
  });
}

function localSkillCommandPaths(subject: PermissionSubject, ctx: GuardContext): string[] {
  if (subject.kind !== "execute" && subject.kind !== "read") return [];
  let args = subject.command ? [subject.command, ...(subject.args ?? [])] : undefined;
  if (!args && subject.rawInput && typeof subject.rawInput === "object") {
    const raw = subject.rawInput as { command?: unknown };
    if (typeof raw.command !== "string" || /[;&|<>$`()\\\r\n]/.test(raw.command)) return [];
    args = tokenize(raw.command);
  }
  if (!args?.length) return [];
  const [command, ...rest] = args;
  if (command === "cat" && rest.length > 0 && rest.every((arg) => isLocalSkillPath(arg, ctx)))
    return rest.map((arg) => lexicalPath(arg, ctx));
  const interpreters = new Set(["bash", "sh", "python", "python3", "node", "bun"]);
  const script = interpreters.has(command!) ? rest[0] : command;
  if (!script || !isLocalSkillPath(script, ctx)) return [];
  return [lexicalPath(script, ctx)];
}

export function classifyPath(input: string, ctx: GuardContext): PathClass {
  if (ctx.hostAccess) return { kind: "inside" };
  const candidate = lexicalPath(input, ctx);
  if (isInside(ctx.worktree, candidate)) {
    if (escapesWorktree(candidate, ctx.worktree)) {
      return { kind: "denied", reason: "path escapes the worktree through a symlink" };
    }
    return { kind: "inside" };
  }
  if (isInside(ctx.pawsRoot, candidate)) {
    return { kind: "denied", reason: "path is under the Paws home" };
  }
  const sensitive = sensitiveReason(candidate, ctx.home);
  if (sensitive) return { kind: "denied", reason: sensitive };
  return { kind: "denied", reason: "path is outside the worktree" };
}

export function resolveInsideWorktree(input: string, ctx: GuardContext): string {
  const classified = classifyPath(input, ctx);
  if (classified.kind === "denied") {
    throw new Error(classified.reason);
  }
  return lexicalPath(input, ctx);
}

export function lexicalPath(input: string, ctx: GuardContext): string {
  const expanded = expandHome(input, ctx.home);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(ctx.worktree, expanded);
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function escapesWorktree(candidate: string, worktree: string): boolean {
  const root = resolve(worktree);
  let current = candidate;
  const missing: string[] = [];
  for (;;) {
    if (current !== root && !isInside(root, current)) return false;
    try {
      const real = realpathSync(current);
      if (!isInside(root, real)) return true;
      const suffix = [...missing].reverse();
      const full = suffix.length === 0 ? real : resolve(real, ...suffix);
      return !isInside(root, full);
    } catch {
      const parent = dirname(current);
      if (parent === current) return false;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function sensitiveReason(candidate: string, home: string): string | undefined {
  const checks: Array<[string, string]> = [
    [join(home, ".ssh"), "path is under ~/.ssh"],
    [join(home, ".config", "gh"), "path is under gh config"],
    [join(home, ".aws"), "path is under ~/.aws"],
    [join(home, ".claude"), "path is an agent credential directory"],
    [join(home, ".codex"), "path is an agent credential directory"],
    [join(home, ".gnupg"), "path is a keychain"],
    [join(home, ".local", "share", "keyrings"), "path is a keychain"],
    [join(home, "Library", "Keychains"), "path is a keychain"],
    [join(home, ".config", "gcloud"), "path is a cloud credential path"],
    [join(home, ".git-credentials"), "path is a credential file"],
    [join(home, ".netrc"), "path is a credential file"],
  ];
  for (const [target, reason] of checks) {
    if (candidate === target || isInside(target, candidate)) return reason;
  }
  if (candidate === "/Library/Keychains" || isInside("/Library/Keychains", candidate)) {
    return "path is a keychain";
  }
  return undefined;
}

function commandText(subject: PermissionSubject): string {
  const parts: string[] = [];
  if (subject.command) parts.push([subject.command, ...(subject.args ?? [])].join(" "));
  const rawCommands: string[] = [];
  walkRaw(subject.rawInput, rawCommands, []);
  parts.push(...rawCommands);
  if (subject.title && (subject.kind === "execute" || looksLikeCommand(subject.title))) {
    parts.push(subject.title);
  }
  return parts.filter(Boolean).join("\n");
}

function collectPaths(subject: PermissionSubject, command: string): string[] {
  const paths: string[] = [];
  for (const location of subject.locations ?? []) {
    if (location?.path) paths.push(location.path);
  }
  walkRaw(subject.rawInput, [], paths);
  const commandTokens =
    subject.command && !subject.rawInput
      ? [subject.command, ...(subject.args ?? [])]
      : tokenize(command);
  for (const token of commandTokens) {
    if (looksLikePath(token)) paths.push(token);
  }
  if (subject.title) {
    for (const token of tokenize(subject.title)) {
      if (looksLikePath(token)) paths.push(token);
    }
  }
  return paths;
}

function walkRaw(value: unknown, commands: string[], paths: string[], key?: string): void {
  if (typeof value === "string") {
    if (key && COMMAND_KEYS.has(key)) commands.push(value);
    else if (looksLikePath(value)) paths.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkRaw(item, commands, paths, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      walkRaw(child, commands, paths, childKey);
    }
  }
}

function looksLikePath(token: string): boolean {
  return (
    token.startsWith("/") || token.startsWith("~") || token.startsWith(".") || token.includes("/")
  );
}

function looksLikeCommand(title: string): boolean {
  return /^(?:git|gh|bun|npm|pnpm|yarn|ssh|scp|curl|wget|cat|ls|bash|sh)\b/.test(title);
}

export function deniedCommandReason(command: string): string | undefined {
  if (
    /\bgit(?:\s+-[^\s]+|\s+--\S+|\s+-C\s+\S+|\s+--git-dir(?:=\S+|\s+\S+)|\s+--work-tree(?:=\S+|\s+\S+))*\s+push\b/.test(
      command,
    )
  ) {
    return "git push is denied";
  }
  if (/(?:^|[\s;&|`$()])gh(?:\s|$)/.test(command) || tokenize(command).includes("gh")) {
    return "gh is denied";
  }
  for (const segment of command.split(/&&|\|\||[;\n|&]/)) {
    const tokens = tokenize(segment);
    const bin = commandBin(tokens);
    if (!bin) continue;
    if (bin === "gh") return "gh is denied";
    if (bin === "git" && gitSubcommand(tokens) === "push") return "git push is denied";
    if (NETWORK_BINS.has(bin)) return `${bin} is denied`;
  }
  return undefined;
}

function isPackageManager(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;\n|&]/)) {
    const bin = commandBin(tokenize(segment));
    if (bin && PACKAGE_MANAGERS.has(bin)) return true;
  }
  return false;
}

function commandBin(tokens: string[]): string | undefined {
  let index = 0;
  const first = tokens[0];
  if (first === "sudo" || first === "command") index = 1;
  if (first === "env") {
    index = 1;
    while (index < tokens.length && (tokens[index]?.includes("=") ?? false)) index += 1;
  }
  const bin = tokens[index];
  if (!bin) return undefined;
  return basename(bin);
}

function gitSubcommand(tokens: string[]): string | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--") return tokens[index + 1];
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=") ||
      token.startsWith("-c")
    ) {
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}
