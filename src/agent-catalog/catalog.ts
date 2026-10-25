import type { Database } from "bun:sqlite";
import {
  lastAgentCatalogRefresh,
  markAgentCatalogRefreshed,
  listAgentVersions,
  readAgentVersion,
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

const PLATFORM_SUFFIX =
  /^(?:linux|darwin|win32|freebsd|openbsd|sunos|aix|android)-(?:x64|arm64|arm|ia32|ppc64|s390x|riscv64|loong64)(?:-(?:musl|gnu|msvc))?$/;
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
  /**
   * Packages whose read failed in the current refresh, with when npm last confirmed their stored
   * document. Their versions are aged as of that time, so none crosses 48 hours on cached data.
   */
  let staleReads = new Map<string, number>();
  /** Set when the version being evaluated consulted a stale package. */
  let usedStale = false;

  async function run(signal?: AbortSignal): Promise<void> {
    const at = now();
    staleReads = new Map();
    const loaded = new Map<string, Promise<Versions | null>>();
    const load = (name: string): Promise<Versions | null> => {
      let pending = loaded.get(name);
      if (!pending) loaded.set(name, (pending = read(name, at, signal)));
      return pending;
    };
    let complete = true;
    for (const [agent, spec] of Object.entries(agents)) {
      try {
        const versions = await load(spec.package);
        if (versions === null) {
          complete = false;
          continue;
        }
        const rows = await evaluateAgent(agent, spec, versions, load, at);
        saveAgentVersions(db, rows);
      } catch (error) {
        complete = false;
        onError(error);
      }
    }
    // Only a refresh in which every agent was evaluated on fresh npm reads counts as the day's
    // refresh. A failed read, an error or a crash part way leaves it due at the next hourly check.
    if (complete && staleReads.size === 0) markAgentCatalogRefreshed(db, at);
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
      staleReads.set(name, stored?.fetchedAt ?? 0);
      return stored?.versions ?? null;
    } catch (error) {
      onError(new Error(`reading ${name} from npm failed: ${message(error)}`));
      staleReads.set(name, stored?.fetchedAt ?? 0);
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
    if (staleReads.has(name)) usedStale = true;
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
    const confirmedAt = staleReads.get(name);
    if ((confirmedAt ?? at) - metadata.publishedAt < AGENT_VERSION_MIN_AGE_MS)
      return {
        status: "waiting",
        reason:
          confirmedAt === undefined || at - metadata.publishedAt < AGENT_VERSION_MIN_AGE_MS
            ? `${label} was published less than 48 hours ago; it is offered from ${new Date(metadata.publishedAt + AGENT_VERSION_MIN_AGE_MS).toISOString()}.`
            : `${label} was published less than 48 hours before Paws last read it from npm; it waits for the next successful read.`,
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
      if (!EXACT.test(target.version) || !platformBuild(target, name, version)) {
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
      usedStale = false;
      const own = check(spec.package, version, versions, true, at);
      const native = await resolveNative(spec, version, metadata, load, at);
      let verdict = worst([own, native.verdict]);
      let nativeVersion = native.version;
      // Cached metadata can only make a version stricter. Otherwise the last verdict and native
      // selection stand until npm answers, so nothing passes a check on a document npm may have
      // changed: a pulled or deprecated version, or a native build never validated as a whole.
      if (usedStale)
        ({ verdict, nativeVersion } = await keepUnlessStricter(
          agent,
          spec,
          version,
          metadata,
          { own, load, at },
          { verdict, nativeVersion },
        ));
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
        nativeVersion,
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

  /**
   * The previous verdict and native selection, unless the new verdict is stricter. With no
   * previous row, the version waits for a fresh read.
   */
  async function keepUnlessStricter(
    agent: string,
    spec: AgentPackage,
    version: string,
    metadata: NpmVersionMetadata,
    current: { own: Verdict; load: (name: string) => Promise<Versions | null>; at: number },
    next: { verdict: Verdict; nativeVersion: string | null },
  ): Promise<{ verdict: Verdict; nativeVersion: string | null }> {
    const previous = readAgentVersion(db, agent, version);
    if (!previous)
      return {
        verdict: worst([
          next.verdict,
          {
            status: "waiting",
            reason: `Paws could not read npm to confirm ${spec.package}@${version}; it waits for the next successful read.`,
          },
        ]),
        nativeVersion: null,
      };
    // The kept selection is checked again against what npm reports now: a native version that
    // was refused, pulled or deprecated since does not stay on offer.
    const verdicts: Verdict[] = [
      { status: previous.status, reason: previous.reason },
      current.own,
      next.verdict,
    ];
    if (previous.nativeVersion !== null) {
      const native = await checkNative(
        spec.native,
        previous.nativeVersion,
        current.load,
        current.at,
      );
      const range = metadata.dependencies[spec.native];
      const ranged = spec.native !== spec.package && range !== undefined && !EXACT.test(range);
      verdicts.push(
        ranged && native.status === "refused"
          ? { status: "ineligible", reason: native.reason }
          : native,
      );
    }
    const verdict = worst(verdicts);
    // A stricter new verdict carries its own selection; otherwise the validated one stands.
    return {
      verdict,
      nativeVersion:
        RANK[next.verdict.status] > RANK[previous.status]
          ? next.nativeVersion
          : previous.nativeVersion,
    };
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
      const last = lastAgentCatalogRefresh(db);
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
function platformBuild(
  pinned: { name: string; version: string },
  carrier: string,
  version: string,
): boolean {
  if (pinned.version === version) return true;
  // Only an npm alias back to the carrier itself may carry a platform suffix, and only an
  // os-arch suffix: a beta or release candidate of the same version is not a platform build.
  return (
    pinned.name === carrier &&
    pinned.version.startsWith(`${version}-`) &&
    PLATFORM_SUFFIX.test(pinned.version.slice(version.length + 1))
  );
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
