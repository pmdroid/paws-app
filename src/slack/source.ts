import { createHash } from "node:crypto";
import {
  auditWorkspaceAccessSteps,
  readSettingSteps,
  updateSettingSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
  type Q,
  type Steps,
} from "../db";
import type { GitHubSnapshotReader, RepositorySnapshot } from "../github";
import { memberRepositoriesSteps } from "../improvements";
import { isWorkspaceAdmin } from "../workspace";

export type SlackSourceRef = { repository: string; ref: string; commit: string };

type Scope = { workspaceId: string; teamId: string; channelId: string; generation: number };
type ThreadPlace = Scope & { threadTs: string };
type ChannelSource = Scope & { repository: string | null; ref: string | null; setBy: string };
type ThreadSource = { generation: number; repository: string | null; ref: string | null };
export type SlackAttachment = { repository: string; ref: string | null; approved: boolean };

export type SlackSourceCommand = {
  kind: "attach";
  channel: boolean;
  repository: string | null;
  ref: string | null;
};

export type SlackSourceOutcome =
  | { kind: "denied" | "unavailable" | "withheld" }
  | { kind: "ready"; source: SlackSourceRef; text: string };

export const SLACK_SOURCE_LIMITS = {
  files: 4,
  fileBytes: 4_000,
  totalBytes: 12_000,
  readableBytes: 64_000,
  pathList: 20,
  cacheEntries: 64,
} as const;

const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}$/;
const SECRET_PATH =
  /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)[^/]*|\.npmrc|\.netrc|\.pypirc|credentials[^/]*|secrets?(\.[^/]*)?)$/i;
const SECRET_LINE =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|xox[abposr]-|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|passw(or)?d|token)["']?\s*[:=]\s*["'][^"'\s]{8,})/i;
const COMMON = new Set([
  "the",
  "and",
  "for",
  "how",
  "what",
  "does",
  "this",
  "that",
  "with",
  "where",
]);

const channelKey = (workspaceId: string) => `slack.repo-default:${workspaceId}`;
const threadKey = (place: ThreadPlace) =>
  `slack.repo:${place.workspaceId}:${place.teamId}:${place.channelId}:${place.threadTs}`;
const parsed = <T>(value: string | null) => (value === null ? null : (JSON.parse(value) as T));
const lower = (name: string) => name.toLowerCase();

export function slackSourceCommand(text: string): SlackSourceCommand | null {
  const match = /^(channel\s+)?repo\s+(\S+)(?:\s+(\S+))?$/i.exec(text.trim());
  if (!match) return null;
  const off = /^(off|none)$/i.test(match[2]!);
  const repository = off ? null : match[2]!;
  const ref = match[3] ?? null;
  if (repository !== null && !REPOSITORY.test(repository)) return null;
  if (ref !== null && (off || !REF.test(ref))) return null;
  return { kind: "attach", channel: !!match[1], repository, ref };
}

function* readsSteps(q: Q, workspaceId: string, userId: string, repository: string) {
  const names = yield* memberRepositoriesSteps(q, workspaceId, userId);
  return names.some((name) => lower(name) === lower(repository));
}

function* channelSourceSteps(q: Q, scope: Scope): Steps<ChannelSource | null> {
  const stored = parsed<ChannelSource>(yield* readSettingSteps(q, channelKey(scope.workspaceId)));
  if (!stored?.repository || stored.teamId !== scope.teamId) return null;
  if (stored.channelId !== scope.channelId || stored.generation !== scope.generation) return null;
  const setter = yield* workspaceMemberSteps(q, scope.workspaceId, stored.setBy);
  if (!workspaceMemberUsable(setter) || !isWorkspaceAdmin(setter.role)) return null;
  return (yield* readsSteps(q, scope.workspaceId, stored.setBy, stored.repository)) ? stored : null;
}

export function* slackAttachmentSteps(q: Q, place: ThreadPlace): Steps<SlackAttachment | null> {
  const channel = yield* channelSourceSteps(q, place);
  const thread = parsed<ThreadSource>(yield* readSettingSteps(q, threadKey(place)));
  const chosen = thread?.generation === place.generation ? thread : channel;
  if (!chosen?.repository) return null;
  const approved = !!channel?.repository && lower(channel.repository) === lower(chosen.repository);
  return { repository: chosen.repository, ref: chosen.ref, approved };
}

export function* slackReadableSteps(q: Q, workspaceId: string, userId: string) {
  return new Set((yield* memberRepositoriesSteps(q, workspaceId, userId)).map(lower));
}

export function* slackSourceCommandSteps(
  q: Q,
  input: { place: ThreadPlace; userId: string; command: SlackSourceCommand; now: number },
): Steps<string> {
  const { place, userId, command, now } = input;
  const { repository, ref } = command;
  if (repository !== null && !(yield* readsSteps(q, place.workspaceId, userId, repository)))
    return "Paws can't attach that repository for you. Attach one your Paws teams can read.";
  const target = repository === null ? "no repository" : `\`${repository}\``;
  const at = ref === null ? "its default branch" : `\`${ref}\``;
  if (!command.channel) {
    const stored: ThreadSource = { generation: place.generation, repository, ref };
    yield* updateSettingSteps(q, threadKey(place), () => JSON.stringify(stored), now);
    return repository === null
      ? "This thread now uses no repository. Paws answers it without reading code."
      : `This thread now reads ${target} at ${at}, read-only. Each answer names the commit it read.`;
  }
  const member = yield* workspaceMemberSteps(q, place.workspaceId, userId);
  if (!workspaceMemberUsable(member) || !isWorkspaceAdmin(member.role))
    return "Only a Paws workspace admin can set this channel's repository.";
  const { workspaceId, teamId, channelId, generation } = place;
  const stored: ChannelSource = {
    ...{ workspaceId, teamId, channelId, generation },
    ...{ repository, ref, setBy: userId },
  };
  yield* updateSettingSteps(q, channelKey(workspaceId), () => JSON.stringify(stored), now);
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId,
    userId,
    action: "slack.channel_repository",
    subject: `slack:${teamId}:${channelId}:${repository ?? "none"}`,
    now,
  });
  return repository === null
    ? "This channel now has no repository."
    : `This channel's repository is now ${target} at ${at}. Paws answers from it, read-only, in threads that attach no other repository.`;
}

function excerptText(bytes: Uint8Array, budget: number): string | null {
  if (bytes.includes(0)) return null;
  const lines = new TextDecoder().decode(bytes).split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const safe = SECRET_LINE.test(line) ? "[line withheld: it looks like a secret]" : line;
    used += Buffer.byteLength(safe) + 1;
    if (used > budget) break;
    kept.push(safe);
  }
  return kept.join("\n");
}

export function createSlackSource(options: { store: Db; reader: GitHubSnapshotReader | null }) {
  const { store, reader } = options;
  const cache = new Map<string, unknown>();
  const cached = async <T>(key: unknown[], load: () => Promise<T>): Promise<T> => {
    const id = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    if (cache.has(id)) {
      const value = cache.get(id) as T;
      cache.delete(id);
      cache.set(id, value);
      return value;
    }
    const value = await load();
    cache.set(id, value);
    for (const old of cache.keys())
      if (cache.size > SLACK_SOURCE_LIMITS.cacheEntries) cache.delete(old);
    return value;
  };

  async function excerpts(
    scope: Scope & { userId: string },
    snapshot: RepositorySnapshot,
    question: string,
    signal: AbortSignal,
  ): Promise<string> {
    const base = [scope.workspaceId, scope.teamId, scope.channelId, scope.generation, scope.userId];
    const at = [...base, lower(snapshot.repository), snapshot.commit];
    const files = await cached([...at, "files"], () => reader!.files(snapshot, signal));
    const terms = [...new Set(question.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])]
      .filter((term) => !COMMON.has(term))
      .slice(0, 12);
    const score = (path: string) => {
      const name = path.toLowerCase();
      const file = name.slice(name.lastIndexOf("/") + 1);
      return terms.reduce(
        (sum, term) => sum + (file.includes(term) ? 3 : name.includes(term) ? 1 : 0),
        0,
      );
    };
    const candidates = files
      .filter((file) => !SECRET_PATH.test(file.path))
      .map((file) => ({ file, score: score(file.path) }))
      .filter((entry) => entry.score > 0 || /^readme(\.[a-z]+)?$/i.test(entry.file.path))
      .sort(
        (left, right) => right.score - left.score || (left.file.path < right.file.path ? -1 : 1),
      );
    const listed = candidates
      .slice(0, SLACK_SOURCE_LIMITS.pathList)
      .map((entry) => entry.file.path);
    const parts = [`Matching paths: ${listed.length ? listed.join(", ") : "none"}`];
    let left = SLACK_SOURCE_LIMITS.totalBytes - Buffer.byteLength(parts[0]!);
    let read = 0;
    for (const { file } of candidates) {
      if (read >= SLACK_SOURCE_LIMITS.files || left <= 200) break;
      if (file.size > SLACK_SOURCE_LIMITS.readableBytes) continue;
      const bytes = await cached([...at, "blob", file.path], () =>
        reader!.read(snapshot, file, signal),
      );
      const budget = Math.min(SLACK_SOURCE_LIMITS.fileBytes, left - 100);
      const text = excerptText(bytes, budget);
      if (text === null) continue;
      const part = `--- ${file.path} ---\n${text}`;
      parts.push(part);
      left -= Buffer.byteLength(part) + 1;
      read++;
    }
    return parts.join("\n");
  }

  async function prepare(input: {
    scope: Scope & { userId: string };
    attached: SlackAttachment;
    question: string;
    signal: AbortSignal;
  }): Promise<SlackSourceOutcome> {
    const { scope, attached } = input;
    const allowed = await store.run((q) =>
      readsSteps(q, scope.workspaceId, scope.userId, attached.repository),
    );
    if (!allowed) return { kind: "denied" };
    const snapshot =
      reader &&
      (await reader.resolve(attached.repository, attached.ref, input.signal).catch(() => null));
    if (!snapshot) return { kind: "unavailable" };
    if (!attached.approved && snapshot.visibility !== "public") return { kind: "withheld" };
    const text = await excerpts(scope, snapshot, input.question, input.signal).catch(() => null);
    if (text === null) return { kind: "unavailable" };
    const { repository, ref, commit } = snapshot;
    return { kind: "ready", source: { repository, ref, commit }, text };
  }

  async function current(input: {
    scope: Scope;
    userId: string;
    source: SlackSourceRef;
    signal: AbortSignal;
  }): Promise<boolean> {
    const { scope, userId, source } = input;
    const policy = await store.run(function* (q) {
      if (!(yield* readsSteps(q, scope.workspaceId, userId, source.repository))) return null;
      const channel = yield* channelSourceSteps(q, scope);
      return {
        approved: !!channel?.repository && lower(channel.repository) === lower(source.repository),
      };
    });
    if (!policy || !reader) return false;
    const snapshot = await reader
      .resolve(source.repository, source.commit, input.signal)
      .catch(() => null);
    return (
      snapshot?.commit === source.commit && (policy.approved || snapshot.visibility === "public")
    );
  }

  return { prepare, current };
}
