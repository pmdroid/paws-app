import type { Database } from "bun:sqlite";
import {
  lastAgentCatalogCheck,
  listAgentVersions,
  readNpmIntegrity,
  readNpmPackage,
  saveAgentVersions,
  saveNpmPackage,
  touchNpmPackage,
  type AgentVersionRow,
  type AgentVersionStatus,
  type NpmVersionMetadata,
} from "../db";
import type { NpmRegistry } from "./registry";

/** An agent's npm package and the package that carries its native builds (its own name if it does). */
export type AgentPackage = { package: string; native: string };

/** The agents the runner installer installs; the same packages as `deploy/linux/release.py`. */
export const AGENT_PACKAGES: Readonly<Record<string, AgentPackage>> = {
  claude: {
    package: "@agentclientprotocol/claude-agent-acp",
    native: "@anthropic-ai/claude-agent-sdk",
  },
  codex: { package: "@agentclientprotocol/codex-acp", native: "@openai/codex" },
  grok: { package: "@xai-official/grok", native: "@xai-official/grok" },
};

/** A version is offered only once it has been on npm this long. */
export const AGENT_VERSION_MIN_AGE_MS = 48 * 60 * 60 * 1000;
/** The registry is read once a day. */
export const AGENT_CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const RANK: Record<AgentVersionStatus, number> = {
  eligible: 0,
  waiting: 1,
  ineligible: 2,
  refused: 3,
};

type Verdict = { status: AgentVersionStatus; reason: string | null };
type Versions = Record<string, NpmVersionMetadata>;

const ELIGIBLE: Verdict = { status: "eligible", reason: null };

export type AgentCatalog = {
  /** Read the registry and re-evaluate every agent version. */
  refresh(signal?: AbortSignal): Promise<void>;
  /** Refresh when the last one is at least a day old. */
  refreshIfDue(signal?: AbortSignal): Promise<boolean>;
};

export function createAgentCatalog(options: {
  db: Database;
  registry: NpmRegistry;
  agents?: Readonly<Record<string, AgentPackage>>;
  now?: () => number;
  onError?: (error: unknown) => void;
}): AgentCatalog {
  const { db, registry } = options;
  const agents = options.agents ?? AGENT_PACKAGES;
  const now = options.now ?? Date.now;
  const onError = options.onError ?? ((error) => console.error(`agent catalog: ${message(error)}`));
  let running: Promise<void> | null = null;

  async function run(signal?: AbortSignal): Promise<void> {
    const at = now();
    const loaded = new Map<string, Promise<Versions | null>>();
    const load = (name: string): Promise<Versions | null> => {
      let pending = loaded.get(name);
      if (!pending) loaded.set(name, (pending = read(name, at, signal)));
      return pending;
    };
    for (const [agent, spec] of Object.entries(agents)) {
      try {
        const versions = await load(spec.package);
        if (versions === null) continue;
        const rows = await evaluateAgent(agent, spec, versions, load, at);
        saveAgentVersions(db, rows);
      } catch (error) {
        onError(error);
      }
    }
  }

  async function read(name: string, at: number, signal?: AbortSignal): Promise<Versions | null> {
    const stored = readNpmPackage(db, name);
    try {
      const result = await registry.fetchPackage(name, stored?.etag ?? null, signal);
      if (result.status === "not-modified" && stored) {
        touchNpmPackage(db, name, at);
        return stored.versions;
      }
      if (result.status === "ok") {
        saveNpmPackage(db, name, result.etag, result.versions, at);
        return result.versions;
      }
      if (result.status === "not-found") {
        saveNpmPackage(db, name, null, {}, at);
        return {};
      }
      return stored?.versions ?? null;
    } catch (error) {
      onError(new Error(`reading ${name} from npm failed: ${message(error)}`));
      return stored?.versions ?? null;
    }
  }

  /** The checks every package version passes: on npm, unchanged integrity, not deprecated, 48 hours old. */
  function check(
    name: string,
    version: string,
    versions: Versions | null,
    stable: boolean,
    at: number,
  ): Verdict {
    const label = `${name}@${version}`;
    if (versions === null)
      return { status: "ineligible", reason: `Paws could not read ${name} from npm.` };
    const record = readNpmIntegrity(db, name, version);
    if (record?.changedIntegrity)
      return {
        status: "refused",
        reason: `The integrity of ${label} changed after Paws first saw it on ${new Date(record.firstSeenAt).toISOString()}.`,
      };
    const metadata = versions[version];
    if (!metadata) return { status: "ineligible", reason: `${label} is not on npm.` };
    if (metadata.integrity === null)
      return { status: "ineligible", reason: `npm lists no integrity for ${label}.` };
    if (stable && !STABLE.test(version))
      return { status: "ineligible", reason: `${label} is a prerelease.` };
    if (metadata.deprecated !== null)
      return {
        status: "ineligible",
        reason: `${label} is deprecated: ${metadata.deprecated.slice(0, 200)}`,
      };
    if (metadata.publishedAt === null)
      return { status: "ineligible", reason: `npm lists no publish time for ${label}.` };
    if (at - metadata.publishedAt < AGENT_VERSION_MIN_AGE_MS)
      return {
        status: "waiting",
        reason: `${label} was published less than 48 hours ago; it is offered from ${new Date(metadata.publishedAt + AGENT_VERSION_MIN_AGE_MS).toISOString()}.`,
      };
    return ELIGIBLE;
  }

  /** The native build package at `version` and each platform package it pins at the same version. */
  async function checkNative(
    name: string,
    version: string,
    load: (name: string) => Promise<Versions | null>,
    at: number,
  ): Promise<Verdict> {
    const versions = await load(name);
    const verdicts = [check(name, version, versions, true, at)];
    const metadata = versions?.[version];
    for (const [alias, pin] of Object.entries(metadata?.optionalDependencies ?? {})) {
      const target = platformPin(alias, pin);
      if (!EXACT.test(target.version) || !sameVersion(target.version, version)) {
        verdicts.push({
          status: "ineligible",
          reason: `${name}@${version} pins ${alias} at ${pin}, not at ${version}.`,
        });
        continue;
      }
      verdicts.push(check(target.name, target.version, await load(target.name), false, at));
    }
    return worst(verdicts);
  }

  async function evaluateAgent(
    agent: string,
    spec: AgentPackage,
    versions: Versions,
    load: (name: string) => Promise<Versions | null>,
    at: number,
  ): Promise<AgentVersionRow[]> {
    const rows: AgentVersionRow[] = [];
    for (const [version, metadata] of Object.entries(versions)) {
      const own = check(spec.package, version, versions, true, at);
      const native = await resolveNative(spec, version, metadata, load, at);
      const verdict = worst([own, native.verdict]);
      const record = readNpmIntegrity(db, spec.package, version);
      const integrity = record?.integrity ?? metadata.integrity;
      if (integrity === null) continue;
      rows.push({
        agent,
        version,
        publishedAt: metadata.publishedAt,
        integrity,
        status: verdict.status,
        firstSeenAt: record?.firstSeenAt ?? at,
        reason: verdict.reason,
        nativeVersion: native.version,
        checkedAt: at,
      });
    }
    // A version npm no longer lists keeps its row, but is never offered again.
    for (const previous of listAgentVersions(db, agent))
      if (!(previous.version in versions)) {
        const refused = previous.status === "refused";
        rows.push({
          ...previous,
          status: refused ? "refused" : "ineligible",
          reason: refused ? previous.reason : `${spec.package}@${previous.version} is not on npm.`,
          checkedAt: at,
        });
      }
    return rows;
  }

  async function resolveNative(
    spec: AgentPackage,
    version: string,
    metadata: NpmVersionMetadata,
    load: (name: string) => Promise<Versions | null>,
    at: number,
  ): Promise<{ version: string | null; verdict: Verdict }> {
    if (spec.native === spec.package)
      return { version, verdict: await checkNative(spec.native, version, load, at) };
    const range = metadata.dependencies[spec.native];
    if (range === undefined)
      return {
        version: null,
        verdict: {
          status: "ineligible",
          reason: `${spec.package}@${version} does not depend on ${spec.native}.`,
        },
      };
    if (EXACT.test(range))
      return { version: range, verdict: await checkNative(spec.native, range, load, at) };
    // A range: the installer takes the newest native version that is itself eligible.
    const candidates = Object.keys((await load(spec.native)) ?? {})
      .filter((candidate) => STABLE.test(candidate) && satisfies(candidate, range))
      .sort((a, b) => Bun.semver.order(b, a));
    let best: { version: string | null; verdict: Verdict } | null = null;
    for (const candidate of candidates) {
      const verdict = await checkNative(spec.native, candidate, load, at);
      if (verdict.status === "eligible") return { version: candidate, verdict };
      if (best === null || RANK[verdict.status] < RANK[best.verdict.status])
        best = { version: candidate, verdict };
    }
    if (best && best.verdict.status === "refused")
      // A refused candidate is skipped by the installer; it does not refuse this agent version.
      best = { version: null, verdict: { status: "ineligible", reason: best.verdict.reason } };
    return (
      best ?? {
        version: null,
        verdict: {
          status: "ineligible",
          reason: `No stable ${spec.native} version matches ${range} for ${spec.package}@${version}.`,
        },
      }
    );
  }

  function refresh(signal?: AbortSignal): Promise<void> {
    if (running) return running;
    running = run(signal).finally(() => {
      running = null;
    });
    return running;
  }

  return {
    refresh,
    async refreshIfDue(signal) {
      const last = lastAgentCatalogCheck(db);
      if (last !== null && now() - last < AGENT_CATALOG_REFRESH_MS) return false;
      await refresh(signal);
      return true;
    },
  };
}

/** `npm:<name>@<version>` aliases name another package; a bare pin names the alias itself. */
function platformPin(alias: string, pin: string): { name: string; version: string } {
  if (!pin.startsWith("npm:")) return { name: alias, version: pin };
  const target = pin.slice(4);
  const at = target.lastIndexOf("@");
  return at <= 0
    ? { name: target, version: "" }
    : { name: target.slice(0, at), version: target.slice(at + 1) };
}

/** `1.2.3` matches `1.2.3`, and a platform build such as `1.2.3-linux-x64` of the same package. */
function sameVersion(pinned: string, version: string): boolean {
  return pinned === version || pinned.startsWith(`${version}-`);
}

function satisfies(version: string, range: string): boolean {
  try {
    return Bun.semver.satisfies(version, range);
  } catch {
    return false;
  }
}

function worst(verdicts: readonly Verdict[]): Verdict {
  let found = ELIGIBLE;
  for (const verdict of verdicts) if (RANK[verdict.status] > RANK[found.status]) found = verdict;
  return found;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
