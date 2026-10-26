import { journalCaught } from "../journal";
import type { SkillPin } from "../db";
import { commitRef, gitRemoteCommit } from "./resolve";

export const SKILL_UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT = 15_000;

export type SkillUpdates = {
  check(skills: readonly SkillPin[]): Promise<void>;
  available(skills: readonly SkillPin[]): Record<string, string>;
};

type LatestCommit = (url: string, ref: string | undefined, signal: AbortSignal) => Promise<string>;

export function createSkillUpdates(options: { latest?: LatestCommit } = {}): SkillUpdates {
  const latest: LatestCommit =
    options.latest ?? ((url, ref, signal) => gitRemoteCommit(url, ref, { signal }));
  const commits = new Map<string, string>();
  return {
    async check(skills) {
      const sources = new Map(
        skills.flatMap((skill) => {
          const source = trackedSource(skill);
          return source ? [[sourceKey(source), source] as const] : [];
        }),
      );
      await Promise.all(
        [...sources].map(async ([key, source]) => {
          try {
            commits.set(
              key,
              await latest(source.url, source.ref, AbortSignal.timeout(CHECK_TIMEOUT)),
            );
          } catch (caughtError1) {
            journalCaught(caughtError1, "updates.check.set", null);
            commits.delete(key);
          }
        }),
      );
    },
    available(skills) {
      const updates: Record<string, string> = {};
      for (const skill of skills) {
        const source = trackedSource(skill);
        const commit = source && commits.get(sourceKey(source));
        if (commit && commit !== skill.version) updates[skill.name] = commit;
      }
      return updates;
    },
  };
}

function trackedSource(skill: SkillPin): { url: string; ref: string | undefined } | null {
  if (skill.removedAt !== null || skill.source.kind !== "git") return null;
  if (skill.source.ref !== undefined && commitRef(skill.source.ref)) return null;
  return { url: skill.source.url, ref: skill.source.ref };
}

function sourceKey(source: { url: string; ref: string | undefined }): string {
  return JSON.stringify([source.url, source.ref ?? null]);
}
