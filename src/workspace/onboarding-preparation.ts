import type { Database } from "bun:sqlite";
import {
  getLinearSession,
  getLinearSessionAccess,
  getLinearSessionInstallation,
  getTaskClassification,
  immediate,
  listRepositoryCatalog,
  requireMemberGitHubSession,
  teamRepositoryAllowedSql,
  workspaceForOrganization,
  workspaceLinearMember,
  type MemberGitHubBinding,
} from "../db";
import {
  chooseRepository,
  hintedRepository,
  repositoryAnswer,
  type LinearRepositoryAdapter,
} from "../linear";
import type { RepositoryBinding, TaskMode } from "../core";

type Context = { sessionId: string; generation: number };
type Row = {
  revision: number;
  scope: string;
  mode: TaskMode | null;
  repository_context: number;
  repository: string | null;
  offered: string;
};
export const PREPARATION_MODES = [
  "code",
  "answer",
  "answer_repository",
  "artifact",
  "artifact_repository",
] as const;
export type OnboardingPreparation = {
  revision: number;
  state: "waiting_mode" | "waiting_repository" | "prepared";
  mode: TaskMode | null;
  repositoryContext: boolean;
  permission: "read" | "push" | null;
  repository: RepositoryBinding | null;
  offered: RepositoryBinding[];
};

export function createOnboardingPreparation(options: {
  db: Database;
  clientId: string;
  repositories: Pick<
    LinearRepositoryAdapter,
    "issueRepositoryHints" | "issueRepositorySuggestions"
  >;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  function scope(context: Context) {
    const session = getLinearSession(db, context.sessionId);
    const installation = getLinearSessionInstallation(db, context.sessionId);
    const workspace = session?.organizationId
      ? workspaceForOrganization(db, session.organizationId)
      : null;
    const hold = db
      .query<
        { workspace_id: string; actor_id: string; fingerprint: string; status: string },
        [string, number]
      >(
        "SELECT workspace_id,actor_id,fingerprint,status FROM workspace_assignment WHERE session_id=? AND generation=?",
      )
      .get(context.sessionId, context.generation);
    const member =
      workspace && hold ? workspaceLinearMember(db, workspace.id, hold.actor_id) : null;
    if (
      !session ||
      session.generation !== context.generation ||
      session.stoppedAt !== null ||
      getLinearSessionAccess(db, context.sessionId) !== "allowed" ||
      !installation?.teamId ||
      installation.oauthClientId !== options.clientId ||
      !workspace ||
      hold?.workspace_id !== workspace.id ||
      !["ready", "accepted", "continued"].includes(hold.status) ||
      session.creatorId !== hold.actor_id ||
      !member?.active ||
      member.role === "observer" ||
      !member.teamIds.includes(installation.teamId)
    )
      throw new Error("Assignment preparation is unavailable.");
    const expected = JSON.parse(hold.fingerprint) as {
      installation?: {
        organizationId?: string;
        oauthClientId?: string;
        appUserId?: string;
        teamId?: string;
      };
      spec?: { linearIssueId?: string };
    };
    if (
      expected.spec?.linearIssueId !== session.issueId ||
      expected.installation?.organizationId !== installation.organizationId ||
      expected.installation?.oauthClientId !== installation.oauthClientId ||
      expected.installation?.appUserId !== installation.appUserId ||
      expected.installation?.teamId !== installation.teamId
    )
      throw new Error("Assignment preparation is unavailable.");
    const candidates = listRepositoryCatalog(db)
      .filter(
        (entry) =>
          db
            .query(`SELECT 1 WHERE ${teamRepositoryAllowedSql("?1", "?2", "lower(?3)")}`)
            .get(workspace.id, installation.teamId, `${entry.owner}/${entry.repo}`) !== null,
      )
      .map(({ owner, repo, remoteUrl }) => ({ owner, repo, remoteUrl }));
    const savedMode = getTaskClassification(db, `session:${context.sessionId}`);
    const fingerprint = JSON.stringify({
      generation: context.generation,
      workspace: workspace.id,
      actor: hold.actor_id,
      user: member.userId,
      team: installation.teamId,
      client: installation.oauthClientId,
      app: installation.appUserId,
      issue: session.issueId,
      fingerprint: hold.fingerprint,
      candidates,
      role: member.role,
      teams: member.teamIds,
      savedMode,
    });
    return { fingerprint, candidates, member, workspace, issueId: session.issueId, savedMode };
  }
  function row(context: Context) {
    return db
      .query<Row, [string, number]>(
        "SELECT revision,scope,mode,repository_context,repository,offered FROM onboarding_preparation WHERE session_id=? AND generation=?",
      )
      .get(context.sessionId, context.generation);
  }
  function project(value: Row): OnboardingPreparation {
    const repository = value.repository
      ? (JSON.parse(value.repository) as RepositoryBinding)
      : null;
    const repositoryContext = value.mode === "code" || value.repository_context === 1;
    return {
      revision: value.revision,
      mode: value.mode,
      repositoryContext,
      repository: value.mode === null || repositoryContext ? repository : null,
      permission:
        value.mode === null || !repositoryContext ? null : value.mode === "code" ? "push" : "read",
      offered: JSON.parse(value.offered),
      state: !value.mode
        ? "waiting_mode"
        : repositoryContext && !repository
          ? "waiting_repository"
          : "prepared",
    };
  }
  function current(context: Context) {
    const authority = scope(context);
    const value = row(context);
    return value?.scope === authority.fingerprint ? { authority, value } : null;
  }
  return {
    read(context: Context): OnboardingPreparation | null {
      const value = current(context);
      return value ? project(value.value) : null;
    },
    async refresh(context: Context, signal: AbortSignal): Promise<OnboardingPreparation> {
      signal.throwIfAborted();
      const initial = immediate(db, () => {
        const authority = scope(context);
        const previous = row(context);
        const saved = authority.savedMode;
        const retained = previous?.scope === authority.fingerprint ? previous : null;
        const mode =
          retained?.mode ??
          (saved && saved.mode !== "clarify" && !saved.redirect ? saved.mode : null);
        const repositoryContext =
          retained?.repository_context ??
          (mode === "code" || (saved?.mode !== "clarify" && saved?.repository === true) ? 1 : 0);
        db.run(
          `INSERT INTO onboarding_preparation(session_id,generation,revision,scope,mode,repository_context,repository,offered,updated_at) VALUES(?,?,1,?,?,?,?,?,?) ON CONFLICT(session_id,generation) DO UPDATE SET revision=revision+1,scope=excluded.scope,mode=excluded.mode,repository_context=excluded.repository_context,repository=excluded.repository,offered=excluded.offered,updated_at=excluded.updated_at`,
          [
            context.sessionId,
            context.generation,
            authority.fingerprint,
            mode,
            repositoryContext,
            retained?.repository ?? null,
            JSON.stringify(authority.candidates),
            now(),
          ],
        );
        return { authority, revision: row(context)!.revision };
      });
      const check = () => {
        signal.throwIfAborted();
        const latest = current(context);
        if (!latest || latest.value.revision !== initial.revision)
          throw new Error("Assignment preparation changed.");
        return latest.value;
      };
      const candidates = initial.authority.candidates;
      let choice: { bind: RepositoryBinding } | { ask: RepositoryBinding[] } = { ask: candidates };
      if (initial.authority.issueId && options.repositories.issueRepositoryHints) {
        const hints = await options.repositories.issueRepositoryHints(initial.authority.issueId, {
          signal,
        });
        check();
        choice = hintedRepository(candidates, hints) ?? choice;
      }
      if (!("bind" in choice) && candidates.length === 1) choice = { bind: candidates[0]! };
      if (!("bind" in choice) && initial.authority.issueId && candidates.length > 1) {
        const suggestions = await options.repositories.issueRepositorySuggestions(
          {
            issueId: initial.authority.issueId,
            candidateRepositories: candidates.map((candidate) => ({
              hostname: "github.com",
              repositoryFullName: `${candidate.owner}/${candidate.repo}`,
            })),
          },
          { signal },
        );
        check();
        const suggested = chooseRepository("ask" in choice ? choice.ask : candidates, suggestions);
        choice = suggested;
      }
      return immediate(db, () => {
        const value = check();
        const existing = value.repository
          ? (JSON.parse(value.repository) as RepositoryBinding)
          : null;
        const selected = existing ?? ("bind" in choice ? choice.bind : null);
        db.run(
          "UPDATE onboarding_preparation SET repository=?,offered=?,updated_at=? WHERE session_id=? AND generation=? AND revision=?",
          [
            selected ? JSON.stringify(selected) : null,
            JSON.stringify("ask" in choice ? choice.ask : candidates),
            now(),
            context.sessionId,
            context.generation,
            initial.revision,
          ],
        );
        return project(row(context)!);
      });
    },
    answer(
      context: Context,
      binding: MemberGitHubBinding | { workspaceId: string; userId: string },
      input: { revision: number; mode?: (typeof PREPARATION_MODES)[number]; repository?: string },
    ): OnboardingPreparation {
      return immediate(db, () => {
        if ("sessionHash" in binding) requireMemberGitHubSession(db, binding, now());
        const selected = current(context);
        if (
          !selected ||
          selected.value.revision !== input.revision ||
          selected.authority.workspace.id !== binding.workspaceId ||
          selected.authority.member.userId !== binding.userId
        )
          throw new Error("Assignment preparation changed.");
        let mode = selected.value.mode;
        let repositoryContext = selected.value.repository_context;
        if (input.mode !== undefined) {
          if (!PREPARATION_MODES.includes(input.mode))
            throw new Error("Choose an offered task mode.");
          mode = input.mode.startsWith("answer")
            ? "answer"
            : input.mode.startsWith("artifact")
              ? "artifact"
              : "code";
          repositoryContext = input.mode === "code" || input.mode.endsWith("_repository") ? 1 : 0;
        }
        let repository = selected.value.repository;
        if (input.repository !== undefined) {
          const chosen = repositoryAnswer(input.repository, JSON.parse(selected.value.offered));
          if (!chosen) throw new Error("Choose an exact offered repository.");
          repository = JSON.stringify(chosen);
        }
        const saved = selected.authority.savedMode;
        if (
          saved &&
          saved.mode !== "clarify" &&
          (mode !== saved.mode ||
            (mode !== "code" && repositoryContext !== (saved.repository === true ? 1 : 0)))
        )
          throw new Error("The canonical task mode changed.");
        if (repositoryContext === 0) repository = null;
        db.run(
          "UPDATE onboarding_preparation SET mode=?,repository_context=?,repository=?,revision=revision+1,updated_at=? WHERE session_id=? AND generation=?",
          [mode, repositoryContext, repository, now(), context.sessionId, context.generation],
        );
        return project(row(context)!);
      });
    },
  };
}
