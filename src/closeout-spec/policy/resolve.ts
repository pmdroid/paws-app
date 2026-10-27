import { journalCaught } from "../../journal";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { policyCanonicalJson, sha256Hex, sha256Text, sortPolicyFiles } from "./canonical";
import { decodeUtf8, isRecord, parsePolicy } from "./document";
import { checkPathPatterns, isSlug, repoPath } from "./paths";
import type {
  PolicyFile,
  PolicyRule,
  ResolvedCommand,
  ResolvedEvidence,
  ResolvedRequirement,
  ResolvedReview,
  ResolvedRule,
  ResolvedSetup,
  RetryPolicy,
} from "../types";

export const PUBLIC_POLICY_PATH = ".agents/closeout.yaml";

/**
 * Most bytes of policy files Paws sends to the runner. A skill or a probe larger than this can
 * never reach it, so a probe past it fails the load.
 */
export const POLICY_MAX_BYTES = 45_000;

type TreeRead =
  | { status: "file"; bytes: Uint8Array }
  | { status: "missing" }
  | { status: "error"; message: string };

type TreeList = { ok: true; paths: string[] } | { ok: false; message: string };

type PolicyTree = {
  read(relativePath: string): TreeRead;
  listSkill(skillFile: string): TreeList;
  /** True when the path, or a directory on the way to it, is a symlink. */
  symlink(relativePath: string): boolean;
};

export type TreePolicy = {
  skillFiles: ReadonlyMap<string, Uint8Array>;
  /** Each rule's probe bytes by probe path. Their hashes are already in `files`. */
  probeFiles: ReadonlyMap<string, Uint8Array>;
  entryPath: string;
  digest: string;
  setup: ResolvedSetup[];
  items: ResolvedRequirement[];
  rules: ResolvedRule[];
  files: PolicyFile[];
  retry?: RetryPolicy;
};

export type TreeLoad =
  | { ok: true; absent: true }
  | { ok: true; absent: false; policy: TreePolicy }
  | { ok: false; message: string };

export function loadMemoryPolicy(files: ReadonlyMap<string, Uint8Array>): TreeLoad {
  return loadTree(memoryTree(files));
}

export function loadHomePolicy(home: string): TreeLoad {
  return loadTree(fsTree(home));
}

function loadTree(tree: PolicyTree): TreeLoad {
  const entry = tree.read(PUBLIC_POLICY_PATH);
  if (entry.status === "missing") return { ok: true, absent: true };
  if (entry.status === "error")
    return { ok: false, message: `${PUBLIC_POLICY_PATH}: ${entry.message}` };
  const state: WalkState = {
    tree,
    retry: undefined,
    setup: [],
    items: [],
    rules: [],
    files: [],
    seenFiles: new Set<string>(),
    skillFiles: new Map(),
    probeFiles: new Map(),
    ids: new Set<string>(),
  };
  const walked = walk(state, PUBLIC_POLICY_PATH, "", []);
  if (walked !== undefined) return { ok: false, message: walked };
  const skills = hashSkills(state);
  if (skills !== undefined) return { ok: false, message: skills };
  const files = sortPolicyFiles(state.files);
  const canonical = policyCanonicalJson({
    files,
    items: state.items,
    setup: state.setup,
    rules: state.rules,
    ...(state.retry !== undefined ? { retry: state.retry } : {}),
  });
  const policy: TreePolicy = {
    skillFiles: state.skillFiles,
    probeFiles: state.probeFiles,
    entryPath: PUBLIC_POLICY_PATH,
    digest: `sha256:${sha256Text(canonical)}`,
    setup: state.setup,
    items: state.items,
    rules: state.rules,
    files,
  };
  if (state.retry !== undefined) policy.retry = state.retry;
  return { ok: true, absent: false, policy };
}

type WalkState = {
  skillFiles: Map<string, Uint8Array>;
  probeFiles: Map<string, Uint8Array>;
  tree: PolicyTree;
  retry: RetryPolicy | undefined;
  setup: ResolvedSetup[];
  items: ResolvedRequirement[];
  rules: ResolvedRule[];
  files: PolicyFile[];
  seenFiles: Set<string>;
  ids: Set<string>;
};

function walk(
  state: WalkState,
  path: string,
  prefix: string,
  stack: readonly string[],
): string | undefined {
  const safe = repoPath(path);
  if (safe === undefined) return `import path is not repository-relative: ${path}`;
  if (stack.includes(safe)) return `import cycle: ${[...stack, safe].join(" -> ")}`;
  const read = state.tree.read(safe);
  if (read.status === "missing") return `import is missing: ${safe}`;
  if (read.status === "error") return `${safe}: ${read.message}`;
  const text = decodeUtf8(read.bytes);
  if (text === undefined) return `${safe}: could not read the policy file`;
  const parsed = parsePolicy(text);
  if (!parsed.ok) return `${safe}: ${parsed.message}`;
  const document = parsed.document;
  if (prefix.length > 0 && document.retry !== undefined) {
    return "retry is only allowed on the entry policy";
  }
  if (prefix.length === 0) state.retry = document.retry;
  if (prefix.length > 0 && document.setup !== undefined && document.setup.length > 0) {
    return "setup is only allowed on the entry policy";
  }
  if (prefix.length > 0 && document.rules !== undefined && document.rules.length > 0) {
    return "rules is only allowed on the entry policy";
  }
  if (!state.seenFiles.has(safe)) {
    state.seenFiles.add(safe);
    state.files.push({ path: safe, sha256: sha256Hex(read.bytes) });
  }
  const names = new Set<string>();
  const childStack = [...stack, safe];
  for (const entry of document.imports ?? []) {
    if (names.has(entry.as)) return `duplicate import name ${entry.as} in ${safe}`;
    names.add(entry.as);
    const childPrefix = prefix.length === 0 ? entry.as : `${prefix}/${entry.as}`;
    const nested = walk(state, entry.path, childPrefix, childStack);
    if (nested !== undefined) return nested;
  }
  if (prefix.length === 0) {
    for (const step of document.setup ?? []) {
      if (!isSlug(step.id)) return `invalid id ${step.id}`;
      if (state.ids.has(step.id)) return `duplicate requirement id ${step.id}`;
      state.ids.add(step.id);
      const paths = checkPathPatterns(step.paths ?? []);
      if (!paths.ok) return paths.message;
      const resolved: ResolvedSetup = {
        id: step.id,
        kind: "setup",
        gate: "beforePR",
        exec: step.exec,
        timeoutSeconds: step.timeoutSeconds,
      };
      if (paths.paths.length > 0) resolved.paths = paths.paths;
      state.setup.push(resolved);
    }
  }
  for (const raw of document.items ?? []) {
    if (!isSlug(raw.id)) return `invalid id ${raw.id}`;
    const id = prefix.length === 0 ? raw.id : `${prefix}/${raw.id}`;
    if (state.ids.has(id)) return `duplicate requirement id ${id}`;
    state.ids.add(id);
    if (raw.kind === "command") {
      const paths = checkPathPatterns(raw.paths ?? []);
      if (!paths.ok) return paths.message;
      const item: ResolvedCommand = {
        id,
        kind: "command",
        gate: "beforePR",
        exec: raw.exec,
        timeoutSeconds: raw.timeoutSeconds,
      };
      if (paths.paths.length > 0) item.paths = paths.paths;
      state.items.push(item);
      continue;
    }
    if (raw.kind === "evidence") {
      const paths = checkPathPatterns(raw.paths ?? []);
      if (!paths.ok) return paths.message;
      const item: ResolvedEvidence = {
        id,
        kind: "evidence",
        gate: "beforePR",
        media: raw.media ?? ["image", "video"],
        minimum: raw.minimum ?? 1,
      };
      if (raw.hint !== undefined) item.hint = raw.hint;
      if (raw.approval !== undefined) item.approval = raw.approval;
      if (paths.paths.length > 0) item.paths = paths.paths;
      state.items.push(item);
      continue;
    }
    const skill = repoPath(raw.skill);
    if (skill === undefined || !skill.endsWith("/SKILL.md")) {
      return `skill path is not a repository SKILL.md: ${raw.skill}`;
    }
    const skillFile = state.tree.read(skill);
    if (skillFile.status !== "file") return `skill is missing: ${skill}`;
    const paths = checkPathPatterns(raw.paths ?? []);
    if (!paths.ok) return paths.message;
    const item: ResolvedReview = {
      id,
      kind: "review",
      gate: "beforePR",
      skill,
      independence: {
        differentSession: raw.independence.differentSession,
        differentModel: raw.independence.differentModel,
      },
      failOn: raw.failOn,
    };
    if (raw.scope !== undefined) item.scope = raw.scope;
    if (raw.parallel !== undefined) item.parallel = raw.parallel;
    if (raw.minChangedLines !== undefined) item.minChangedLines = raw.minChangedLines;
    if (paths.paths.length > 0) item.paths = paths.paths;
    state.items.push(item);
  }
  for (const raw of document.rules ?? []) {
    const rule = resolveRule(state, raw);
    if (typeof rule === "string") return rule;
    state.rules.push(rule);
  }
  return undefined;
}

/**
 * The probe is read from the policy tree: the `origin/main` commit of the entry, or the local
 * or home policy root. Its hash joins `files`, so changing its bytes changes the digest.
 */
function resolveRule(state: WalkState, raw: PolicyRule): ResolvedRule | string {
  if (!isSlug(raw.id)) return `invalid id ${raw.id}`;
  if (state.ids.has(raw.id)) return `duplicate requirement id ${raw.id}`;
  state.ids.add(raw.id);
  const probe = repoPath(raw.probe);
  if (probe === undefined) return `probe path is not repository-relative: ${raw.probe}`;
  if (state.tree.symlink(probe)) return `probe is a symlink: ${probe}`;
  const read = state.tree.read(probe);
  if (read.status === "missing") return `probe is missing: ${probe}`;
  if (read.status === "error") return `${probe}: ${read.message}`;
  if (read.bytes.byteLength > POLICY_MAX_BYTES)
    return `probe is larger than ${POLICY_MAX_BYTES} bytes: ${probe}`;
  const paths = checkPathPatterns(raw.paths ?? []);
  if (!paths.ok) return paths.message;
  const sha256 = sha256Hex(read.bytes);
  state.probeFiles.set(probe, read.bytes);
  if (!state.seenFiles.has(probe)) {
    state.seenFiles.add(probe);
    state.files.push({ path: probe, sha256 });
  }
  const rule: ResolvedRule = {
    id: raw.id,
    probe,
    probeSha256: sha256,
    exec: raw.exec ?? ["bun"],
    summary: raw.summary,
    failOn: raw.failOn,
    onFail: raw.onFail ?? "fix",
  };
  if (paths.paths.length > 0) rule.paths = paths.paths;
  return rule;
}

function hashSkills(state: WalkState): string | undefined {
  const seen = new Set<string>();
  for (const item of state.items) {
    if (item.kind !== "review" || "supported" in item) continue;
    const listed = state.tree.listSkill(item.skill);
    if (!listed.ok) return listed.message;
    for (const path of listed.paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const read = state.tree.read(path);
      if (read.status !== "file") return "could not read the policy file";
      state.files.push({ path, sha256: sha256Hex(read.bytes) });
      state.skillFiles.set(path, read.bytes);
    }
  }
  return undefined;
}

function memoryTree(files: ReadonlyMap<string, Uint8Array>): PolicyTree {
  return {
    read(relativePath) {
      const bytes = files.get(relativePath);
      if (bytes === undefined) return { status: "missing" };
      return { status: "file", bytes };
    },
    listSkill(skillFile) {
      const slash = skillFile.lastIndexOf("/");
      if (slash <= 0) return { ok: false, message: `skill is missing: ${skillFile}` };
      if (!files.has(skillFile)) return { ok: false, message: `skill is missing: ${skillFile}` };
      const prefix = `${skillFile.slice(0, slash)}/`;
      const paths: string[] = [];
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) paths.push(path);
      }
      return { ok: true, paths };
    },
    symlink() {
      return false;
    },
  };
}

function fsTree(root: string): PolicyTree {
  const rootAbs = resolve(root);
  return {
    read(relativePath) {
      const absolute = inside(rootAbs, relativePath);
      if (absolute === undefined) return { status: "missing" };
      try {
        if (!statSync(absolute).isFile()) return { status: "missing" };
      } catch (caughtError1) {
        journalCaught(caughtError1, "resolve.read.isFile", null);
        return { status: "missing" };
      }
      try {
        return { status: "file", bytes: new Uint8Array(readFileSync(absolute)) };
      } catch (caughtError2) {
        journalCaught(
          caughtError2,
          "resolve.read.readFileSync",
          null,
          "optional file may be absent",
        );
        return { status: "error", message: "could not read the policy file" };
      }
    },
    listSkill(skillFile) {
      return listSkillFiles(rootAbs, skillFile);
    },
    symlink(relativePath) {
      if (repoPath(relativePath) === undefined) return false;
      let current = rootAbs;
      for (const segment of relativePath.split("/")) {
        current = join(current, segment);
        try {
          if (lstatSync(current).isSymbolicLink()) return true;
        } catch (caughtError5) {
          journalCaught(
            caughtError5,
            "resolve.symlink.lstatSync",
            null,
            "optional file may be absent",
          );
          return false;
        }
      }
      return false;
    },
  };
}

function inside(root: string, relativePath: string): string | undefined {
  if (repoPath(relativePath) === undefined) return undefined;
  const absolute = resolve(root, ...relativePath.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return undefined;
  return absolute;
}

function listSkillFiles(root: string, skillFile: string): TreeList {
  const slash = skillFile.lastIndexOf("/");
  if (slash <= 0) return { ok: false, message: `skill is missing: ${skillFile}` };
  const dirAbs = inside(root, skillFile.slice(0, slash));
  if (dirAbs === undefined) return { ok: false, message: `skill is missing: ${skillFile}` };
  let dirStat;
  try {
    dirStat = lstatSync(dirAbs);
  } catch (caughtError3) {
    journalCaught(
      caughtError3,
      "resolve.listSkillFiles.lstatSync",
      null,
      "optional file may be absent",
    );
    return { ok: false, message: `skill is missing: ${skillFile}` };
  }
  if (dirStat.isSymbolicLink()) return { ok: false, message: `skill file is a symlink: ${dirAbs}` };
  if (!dirStat.isDirectory()) return { ok: false, message: `skill is missing: ${skillFile}` };
  const found: string[] = [];
  const stack = [dirAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (caughtError4) {
      journalCaught(
        caughtError4,
        "resolve.listSkillFiles.readdirSync",
        null,
        "optional file may be absent",
      );
      return { ok: false, message: "could not read the skill directory" };
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink())
        return { ok: false, message: `skill file is a symlink: ${absolute}` };
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, absolute);
      if (rel.startsWith(".."))
        return { ok: false, message: `skill file is a symlink: ${absolute}` };
      found.push(rel.split(sep).join("/"));
    }
  }
  return { ok: true, paths: found };
}

/** Queues imports, skills and probes. Probes are also added to `probes`, which are not YAML. */
export function enqueuePolicyPaths(value: unknown, pending: string[], probes?: Set<string>): void {
  if (!isRecord(value)) return;
  if (Array.isArray(value.imports)) {
    for (const entry of value.imports) {
      if (isRecord(entry) && typeof entry.path === "string") pending.push(entry.path);
    }
  }
  if (Array.isArray(value.items)) {
    for (const item of value.items) {
      if (isRecord(item) && typeof item.skill === "string") pending.push(item.skill);
    }
  }
  if (Array.isArray(value.rules)) {
    for (const rule of value.rules) {
      if (!isRecord(rule) || typeof rule.probe !== "string") continue;
      pending.push(rule.probe);
      probes?.add(rule.probe);
    }
  }
}
