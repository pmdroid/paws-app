import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  RUNNER_SKILL_BUNDLE_LIMIT,
  RUNNER_SKILL_FOLDERS,
  RunnerSkillManifestSchema,
  runnerSkillPath,
  tarModes,
  type RunnerInstalledSkill,
  type RunnerSkill,
  type RunnerSkillAgent,
} from "../runner-protocol";

type Installed = { version: string; sha256: string; agents: RunnerSkillAgent[]; modes?: true };
type Refused = { name: string; version: string; sha256: string; at: number; error?: string };
type State = {
  /** Skills every idle home should have. A refused update keeps the previous version here. */
  desired: RunnerSkill[];
  refused: Refused[];
  /** What Paws installed in each home, so removals only touch skills Paws put there. */
  homes: Record<string, Record<string, Installed>>;
  folders?: Record<string, string>;
};

const VERSIONED: readonly RunnerSkillAgent[] = ["claude", "codex"];
const VERSIONS = ".paws-skills/versions";

/** A refused bundle is not downloaded again for this long unless Paws pins another one. */
const REFUSED_RETRY_MS = 10 * 60_000;

export type RunnerSkillInstallerOptions = {
  /** Private runner state: verified bundles and what each home has installed. */
  root: string;
  /** Homes agents run from. Every run uses the runner's one agent home today. */
  homes?: readonly string[];
  /** Owner of every installed file: the agent user, as the agent home is. */
  owner: { uid: number; gid: number };
  download(skill: RunnerSkill): Promise<Uint8Array>;
  onError?(error: Error): void;
  now?: () => number;
};

/**
 * Installs the registered skills into every agent home. A home with a run in progress keeps the
 * versions its runs started with; it updates once no run is using it.
 */
export function createRunnerSkillInstaller(options: RunnerSkillInstallerOptions) {
  const agentHomes = options.homes ?? ["/var/lib/paws-agent"];
  const now = options.now ?? Date.now;
  const bundles = join(options.root, "bundles");
  const statePath = join(options.root, "state.json");
  mkdirSync(bundles, { recursive: true, mode: 0o700 });
  let state = readState();
  const holds = new Map<string, { home: string; folder?: string }>();
  let syncing: Promise<void> | undefined;
  let queued: readonly RunnerSkill[] | undefined;

  function report(error: unknown) {
    options.onError?.(error instanceof Error ? error : new Error("Runner skill install failed."));
  }
  function readState(): State {
    try {
      return JSON.parse(readFileSync(statePath, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(error);
      return { desired: [], refused: [], homes: {} };
    }
  }
  function saveState() {
    const partial = `${statePath}.${randomUUID()}.partial`;
    writeFileSync(partial, JSON.stringify(state), { mode: 0o600 });
    renameSync(partial, statePath);
  }
  const unpackedName = (sha256: string) => `${sha256}.modes`;
  const bundlePath = (sha256: string) => join(bundles, unpackedName(sha256));

  /** Check the bytes against the manifest and keep the unpacked files under `bundles/<sha256>/`. */
  async function fetchBundle(skill: RunnerSkill) {
    if (existsSync(bundlePath(skill.sha256))) return;
    const bytes = await options.download(skill);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== skill.sizeBytes || sha256 !== skill.sha256)
      throw new Error(
        `Skill ${skill.name} ${skill.version} failed its checksum and was not installed.`,
      );
    const files = await new Bun.Archive(bytes).files();
    const modes = tarModes(bytes);
    const partial = join(bundles, `${skill.sha256}.${randomUUID()}.partial`);
    try {
      let size = 0;
      for (const [path, file] of files) {
        const safe = runnerSkillPath(path);
        if (safe === null) throw new Error(`Skill ${skill.name} has a file outside its folder.`);
        size += file.size;
        if (size > RUNNER_SKILL_BUNDLE_LIMIT)
          throw new Error(`Skill ${skill.name} is over the bundle limit.`);
        mkdirSync(dirname(join(partial, safe)), { recursive: true, mode: 0o700 });
        writeFileSync(join(partial, safe), new Uint8Array(await file.arrayBuffer()), {
          mode: privateMode(modes.get(path) ?? 0),
          flag: "wx",
        });
      }
      if (!existsSync(join(partial, "SKILL.md")))
        throw new Error(`Skill ${skill.name} has no SKILL.md.`);
      renameSync(partial, bundlePath(skill.sha256));
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  /** A directory under `home` that is ours to write: created for the owner, never a symlink. */
  function ownedDirectory(home: string, relative: string): string {
    let path = home;
    for (const part of relative.split("/")) {
      path = join(path, part);
      try {
        mkdirSync(path, { mode: 0o700 });
        lchownSync(path, options.owner.uid, options.owner.gid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!lstatSync(path).isDirectory()) throw new Error(`${path} is not a directory.`);
    }
    return path;
  }
  function copyTree(from: string, to: string) {
    mkdirSync(to, { mode: 0o755 });
    chmodSync(to, 0o755);
    lchownSync(to, options.owner.uid, options.owner.gid);
    for (const entry of readdirSync(from)) {
      const source = join(from, entry);
      const target = join(to, entry);
      if (lstatSync(source).isDirectory()) copyTree(source, target);
      else {
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        chmodSync(target, privateMode(lstatSync(source).mode));
        lchownSync(target, options.owner.uid, options.owner.gid);
      }
    }
  }
  /**
   * Stage the full skill inside the home, then rename it into place, so the skill folder is
   * never partly written. Homes with a run in progress are not touched at all.
   */
  function installFolder(home: string, agent: RunnerSkillAgent, skill: RunnerSkill) {
    const staging = ownedDirectory(home, ".paws-skills");
    const folder = ownedDirectory(home, RUNNER_SKILL_FOLDERS[agent]);
    const staged = join(staging, `${skill.name}.${randomUUID()}`);
    try {
      copyTree(bundlePath(skill.sha256), staged);
      removeFolder(home, agent, skill.name);
      renameSync(staged, join(folder, skill.name));
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  }
  function removeFolder(home: string, agent: RunnerSkillAgent, name: string) {
    const target = join(home, RUNNER_SKILL_FOLDERS[agent], name);
    try {
      lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const retired = join(ownedDirectory(home, ".paws-skills"), `${name}.${randomUUID()}.old`);
    renameSync(target, retired);
    rmSync(retired, { recursive: true, force: true });
  }

  function folderId(): string {
    const versioned = state.desired
      .map((skill) => [skill.name, skill.sha256, versionedAgents(skill)] as const)
      .filter(([, , agents]) => agents.length);
    return createHash("sha256").update(JSON.stringify(versioned)).digest("hex").slice(0, 32);
  }
  const foldersOf = (home: string) => join(home, VERSIONS);
  function buildFolder(home: string): void {
    const id = folderId();
    const target = join(ownedDirectory(home, VERSIONS), id);
    if (!existsSync(target)) {
      const name = `${id}.${randomUUID()}`;
      const staging = ownedDirectory(home, ".paws-skills");
      ownedDirectory(staging, name);
      try {
        for (const skill of state.desired)
          for (const agent of versionedAgents(skill))
            copyTree(
              bundlePath(skill.sha256),
              join(ownedDirectory(staging, `${name}/${RUNNER_SKILL_FOLDERS[agent]}`), skill.name),
            );
        renameSync(join(staging, name), target);
      } finally {
        rmSync(join(staging, name), { recursive: true, force: true });
      }
    }
    (state.folders ??= {})[home] = id;
  }
  function pruneFolders(home: string): void {
    const keep = new Set(
      [...holds.values()].filter((hold) => hold.home === home).map((hold) => hold.folder),
    );
    const current = state.folders?.[home];
    if (current) keep.add(join(foldersOf(home), current));
    for (const entry of readdirSync(foldersOf(home), { withFileTypes: true }))
      if (!keep.has(join(foldersOf(home), entry.name)))
        rmSync(join(foldersOf(home), entry.name), { recursive: true, force: true });
  }

  /** Bring one home to the desired skills, unless a run in progress is pinned to what it has. */
  function applyHome(home: string): void {
    if (!lstatSync(home, { throwIfNoEntry: false })?.isDirectory()) return;
    try {
      buildFolder(home);
      pruneFolders(home);
    } catch (error) {
      report(error);
    }
    saveState();
    if ([...holds.values()].some((hold) => hold.home === home)) return;
    const current = state.homes[home] ?? {};
    const next: Record<string, Installed> = {};
    for (const skill of state.desired) {
      const have = current[skill.name];
      const agents = skill.agents.filter((agent) => !VERSIONED.includes(agent));
      try {
        for (const agent of have?.agents ?? [])
          if (!agents.includes(agent)) removeFolder(home, agent, skill.name);
        for (const agent of agents)
          if (have?.sha256 !== skill.sha256 || !have.modes || !have.agents.includes(agent))
            installFolder(home, agent, skill);
        next[skill.name] = {
          version: skill.version,
          sha256: skill.sha256,
          agents,
          modes: true,
        };
      } catch (error) {
        report(error);
        if (have) next[skill.name] = have;
      }
    }
    for (const [name, have] of Object.entries(current)) {
      if (state.desired.some((skill) => skill.name === name)) continue;
      try {
        for (const agent of have.agents) removeFolder(home, agent, name);
      } catch (error) {
        report(error);
        next[name] = have;
      }
    }
    state.homes[home] = next;
    saveState();
  }
  function homes(): string[] {
    return agentHomes.filter((home) => existsSync(home));
  }

  async function apply(manifest: readonly RunnerSkill[]) {
    const desired: RunnerSkill[] = [];
    const refused: Refused[] = [];
    for (const skill of RunnerSkillManifestSchema.parse(manifest)) {
      const earlier = state.refused.find(
        (entry) => entry.name === skill.name && entry.sha256 === skill.sha256,
      );
      const previous = state.desired.find((entry) => entry.name === skill.name);
      const keepPrevious = () => {
        if (previous && existsSync(bundlePath(previous.sha256))) desired.push(previous);
      };
      if (earlier && earlier.at + REFUSED_RETRY_MS > now()) {
        refused.push(earlier);
        keepPrevious();
        continue;
      }
      try {
        await fetchBundle(skill);
        desired.push(skill);
      } catch (error) {
        report(error);
        refused.push({
          name: skill.name,
          version: skill.version,
          sha256: skill.sha256,
          at: now(),
          error: installError(error),
        });
        keepPrevious();
      }
    }
    state.desired = desired;
    state.refused = refused;
    saveState();
    for (const home of Object.keys(state.homes)) if (!existsSync(home)) delete state.homes[home];
    for (const home of Object.keys(state.folders ?? {}))
      if (!existsSync(home)) delete state.folders![home];
    for (const home of homes()) applyHome(home);
    const keep = new Set(desired.map((skill) => unpackedName(skill.sha256)));
    for (const entry of readdirSync(bundles))
      if (!keep.has(entry)) rmSync(join(bundles, entry), { recursive: true, force: true });
    saveState();
  }

  return {
    /** Install `manifest` everywhere it can. Calls made while a sync runs apply the latest one after it. */
    sync(manifest: readonly RunnerSkill[]): Promise<void> {
      if (syncing) {
        queued = manifest;
        return syncing;
      }
      syncing = (async () => {
        let next: readonly RunnerSkill[] | undefined = manifest;
        while (next) {
          queued = undefined;
          await apply(next);
          next = queued;
        }
      })().finally(() => {
        syncing = undefined;
      });
      return syncing;
    },
    /** Called before a worker starts in `home`, so a new home has the skills before its first run. */
    prepareHome(home: string): void {
      try {
        applyHome(home);
      } catch (error) {
        report(error);
      }
    },
    /** Pin `home` to its installed skills while `executionId` runs there. */
    hold(home: string, executionId: string): string | undefined {
      const held = holds.get(executionId);
      if (held?.home === home) return held.folder;
      const id = state.folders?.[home];
      const folder = id ? join(foldersOf(home), id) : undefined;
      holds.set(executionId, { home, ...(folder ? { folder } : {}) });
      return folder;
    },
    release(executionId: string): void {
      holds.delete(executionId);
    },
    /** What the runner reports in its heartbeat. */
    installed(): RunnerInstalledSkill[] {
      const reported: RunnerInstalledSkill[] = state.refused.map(
        ({ name, version, sha256, error }) => ({
          name,
          version,
          sha256,
          status: "refused",
          ...(error ? { error } : {}),
        }),
      );
      for (const skill of state.desired) {
        if (reported.some((entry) => entry.name === skill.name)) continue;
        const shared = skill.agents.some((agent) => !VERSIONED.includes(agent));
        const behind = (home: string) => {
          const entry = state.homes[home]?.[skill.name];
          return (
            (shared && (entry?.sha256 !== skill.sha256 || !entry?.modes)) ||
            (versionedAgents(skill).length > 0 && state.folders?.[home] !== folderId())
          );
        };
        const waiting = [...holds.values()].filter((hold) => behind(hold.home)).length;
        reported.push({
          name: skill.name,
          version: skill.version,
          sha256: skill.sha256,
          status: Object.keys(state.homes).some(behind) ? "pending" : "installed",
          ...(waiting ? { waiting } : {}),
        });
      }
      return reported;
    },
  };
}

function versionedAgents(skill: RunnerSkill): RunnerSkillAgent[] {
  return skill.agents.filter((agent) => VERSIONED.includes(agent));
}

function privateMode(mode: number): number {
  return mode & 0o111 ? 0o700 : 0o600;
}

function installError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (!message || /(?:^|\s)\/\S/.test(message))
    return "The skill could not be downloaded or unpacked.";
  return message.slice(0, 500);
}

export type RunnerSkillInstaller = ReturnType<typeof createRunnerSkillInstaller>;
