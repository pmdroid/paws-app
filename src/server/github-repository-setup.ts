import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  authorizeHostedGitHubUser,
  createWorkspaceGitHubActivation,
  githubAppAuthorization,
  hash,
  newGitHubOAuthSecret,
  verifyHostedGitHubRepositories,
  type ActiveGitHubApp,
} from "../auth";
import {
  auditWorkspaceAccess,
  enqueueJob,
  immediate,
  listWorkspaceRepositories,
  replaceWorkspaceRepositories,
} from "../db";
import { readWorkspaceJson, requestWorkspaceSession, validWorkspaceCsrf } from "../workspace";
import { discoverGitHubInstallation } from "./github-connect-status";
import { githubRepositoryChoices } from "./github-repository-choices";

const START = "/api/workspaces/github-setup";
const CALLBACK = "/auth/github-app/callback";
const KIND = "repository-setup";
type Pending = {
  state_hash: string;
  secret_id: string;
  expected_generation: number;
  intent: string;
  expires_at: number;
  status: string;
};
type Secret = {
  app: ActiveGitHubApp;
  verifier: string;
  user?: { id: number; login: string; token: string };
};

export function createGitHubRepositorySetup(options: {
  db: Database;
  home: string;
  env: Record<string, string | undefined>;
  origin: string;
  teams: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<{ id: string; name: string; key: string }[]>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const http = options.fetch ?? fetch;
  const activation = createWorkspaceGitHubActivation(db, options.home, options.env);
  const origin = new URL(options.origin).origin;
  if (!origin.startsWith("https://")) throw new Error("GitHub setup requires HTTPS.");
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== START && url.pathname !== CALLBACK) return null;
    const state = url.searchParams.get("state");
    if (
      url.pathname === CALLBACK &&
      (!state ||
        state.length > 128 ||
        !db
          .query(
            "SELECT 1 FROM workspace_github_oauth WHERE state_hash=? AND json_extract(intent,'$.kind')=?",
          )
          .get(hash(state), KIND))
    )
      return null;
    const access = requestWorkspaceSession(db, request, now());
    const denied = () =>
      reply(
        {
          code: access?.principal.role === "owner" ? "reauth_required" : "owner_required",
          error:
            access?.principal.role === "owner"
              ? "Sign in again to set up GitHub repositories."
              : "Ask a workspace owner to set up GitHub repositories.",
        },
        403,
      );
    const permitted = () => {
      const current = requestWorkspaceSession(db, request, now());
      return (
        access &&
        current?.session.tokenHash === access.session.tokenHash &&
        current.principal.workspaceId === access.principal.workspaceId &&
        current.principal.role === "owner" &&
        now() >= current.principal.authenticatedAt &&
        now() - current.principal.authenticatedAt <= 900_000
      );
    };
    const selected = url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
    if (
      url.origin !== origin ||
      (request.headers.has("host") && request.headers.get("host") !== url.host) ||
      !permitted() ||
      (selected !== null && selected !== access!.principal.workspaceId)
    )
      return denied();
    if (
      (url.pathname === CALLBACK && request.method !== "GET") ||
      (url.pathname === START && !["GET", "POST", "PUT"].includes(request.method))
    )
      return reply({ error: "Method not allowed" }, 405);
    if (
      !["GET"].includes(request.method) &&
      (request.headers.get("origin") !== origin || !validWorkspaceCsrf(request, access!.session))
    )
      return denied();
    const workspaceId = access!.principal.workspaceId;
    const userId = access!.principal.userId;
    const sessionHash = access!.session.tokenHash;
    const scope = () => JSON.stringify(listWorkspaceRepositories(db, workspaceId));
    const generation = () =>
      db
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM workspace_github_connection WHERE workspace_id=?",
        )
        .get(workspaceId)?.generation ?? 0;
    const find = () =>
      db
        .query<Pending, [string, string, string, string, number]>(
          "SELECT * FROM workspace_github_oauth WHERE workspace_id=? AND user_id=? AND session_hash=? AND json_extract(intent,'$.kind')=? AND status='complete' AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
        )
        .get(workspaceId, userId, sessionHash, KIND, now());
    const unchanged = (pending: Pending, secret: Secret) => {
      const row = find();
      return (
        permitted() &&
        row?.state_hash === pending.state_hash &&
        row.secret_id === pending.secret_id &&
        row.expected_generation === pending.expected_generation &&
        row.intent === pending.intent &&
        pending.expires_at > now() &&
        generation() === pending.expected_generation &&
        JSON.parse(pending.intent).scope === scope() &&
        JSON.stringify(activation.template()) === JSON.stringify(secret.app)
      );
    };
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    try {
      for (const expired of db
        .query<{ state_hash: string; secret_id: string }, [string, string, number]>(
          "SELECT state_hash,secret_id FROM workspace_github_oauth WHERE workspace_id=? AND json_extract(intent,'$.kind')=? AND expires_at<=?",
        )
        .all(workspaceId, KIND, now())) {
        activation.remove(expired.secret_id);
        db.run("DELETE FROM workspace_github_oauth WHERE state_hash=?", [expired.state_hash]);
      }
      if (url.pathname === CALLBACK) {
        const code = url.searchParams.get("code");
        if (!state || !code || code.length > 4096 || url.searchParams.has("error"))
          return reply({ error: "GitHub sign-in was not completed. Start again." }, 400);
        const pending = db
          .query<Pending, [string, string, string, string, number]>(
            "UPDATE workspace_github_oauth SET status='claimed' WHERE state_hash=? AND workspace_id=? AND user_id=? AND session_hash=? AND status='pending' AND expires_at>? RETURNING *",
          )
          .get(hash(state), workspaceId, userId, sessionHash, now());
        if (!pending) return denied();
        const secret = activation.read<Secret>(pending.secret_id);
        let grantId: string | undefined;
        try {
          const user = await authorizeHostedGitHubUser({
            ...secret,
            code,
            redirectUri: origin + CALLBACK,
            signal,
            fetch: http,
          });
          await discoverGitHubInstallation(secret.app, [], signal, http);
          if (
            !permitted() ||
            pending.expires_at <= now() ||
            generation() !== pending.expected_generation ||
            JSON.parse(pending.intent).scope !== scope() ||
            JSON.stringify(activation.template()) !== JSON.stringify(secret.app)
          )
            return denied();
          grantId = randomUUID();
          activation.save(grantId, { ...secret, user });
          const changed = db.run(
            "UPDATE workspace_github_oauth SET status='complete',secret_id=? WHERE state_hash=? AND status='claimed'",
            [grantId, pending.state_hash],
          );
          if (changed.changes !== 1) throw new Error("GitHub setup changed. Start again.");
          grantId = undefined;
          return new Response(null, {
            status: 303,
            headers: {
              location: origin + "/status#/settings/integrations",
              "cache-control": "no-store",
            },
          });
        } finally {
          activation.remove(pending.secret_id);
          if (grantId) activation.remove(grantId);
          db.run(
            "UPDATE workspace_github_oauth SET status='failed' WHERE state_hash=? AND status='claimed'",
            [pending.state_hash],
          );
        }
      }
      if (request.method === "POST") {
        const body = await readWorkspaceJson(request);
        if (!record(body) || Object.keys(body).length)
          return reply({ error: "Invalid GitHub sign-in request." }, 400);
        const app = activation.template();
        const secret = newGitHubOAuthSecret();
        activation.save(secret.id, { app, verifier: secret.verifier });
        try {
          immediate(db, () => {
            if (!permitted()) throw new Error("Workspace access changed. Sign in again.");
            db.run(
              "INSERT INTO workspace_github_oauth(state_hash,workspace_id,user_id,session_hash,secret_id,expected_generation,intent,expires_at) VALUES(?,?,?,?,?,?,?,?)",
              [
                hash(secret.state),
                workspaceId,
                userId,
                sessionHash,
                secret.id,
                generation(),
                JSON.stringify({ kind: KIND, scope: scope() }),
                now() + 600_000,
              ],
            );
          });
        } catch (error) {
          activation.remove(secret.id);
          throw error;
        }
        return reply({
          authorizationUrl: githubAppAuthorization({
            clientId: app.clientId,
            redirectUri: origin + CALLBACK,
            state: secret.state,
            verifier: secret.verifier,
          }),
        });
      }
      const pending = find();
      if (!pending)
        return request.method === "PUT"
          ? reply(
              {
                error: "Sign in with GitHub before saving repositories.",
                code: "github_signin_required",
              },
              409,
            )
          : reply({ signedIn: false, mappings: listWorkspaceRepositories(db, workspaceId) });
      const secret = activation.read<Secret>(pending.secret_id);
      if (!secret.user || !unchanged(pending, secret))
        return reply(
          {
            error: "Workspace access changed. Sign in with GitHub again.",
            code: "github_signin_required",
          },
          409,
        );
      const body = request.method === "PUT" ? await readWorkspaceJson(request) : null;
      const selection =
        request.method === "PUT" && record(body)
          ? body.installationId
          : url.searchParams.get("installationId");
      if (selection !== null && (typeof selection !== "string" || !/^[1-9][0-9]*$/.test(selection)))
        return reply({ error: "Choose a GitHub account." }, 400);
      const [choices, teams] = await Promise.all([
        githubRepositoryChoices(
          secret.app,
          secret.user.token,
          selection as string | null,
          signal,
          http,
        ),
        options.teams(request, signal),
      ]);
      if (!unchanged(pending, secret)) return denied();
      if (request.method === "GET")
        return reply({
          signedIn: true,
          setupId: pending.state_hash,
          login: secret.user.login,
          ...choices,
          teams,
          mappings: listWorkspaceRepositories(db, workspaceId),
        });
      if (choices.missingPermissions.length)
        return reply(
          {
            code: "github_permissions_required",
            error: "Approve the required GitHub App permissions before saving repository access.",
          },
          409,
        );
      if (
        !record(body) ||
        Object.keys(body).some((key) => !["installationId", "mappings", "setupId"].includes(key)) ||
        body.setupId !== pending.state_hash ||
        !Array.isArray(body.mappings) ||
        body.mappings.length > 100 ||
        !choices.installationId
      )
        return reply({ error: "Choose repositories and their Linear teams." }, 400);
      const mappings: { repository: string; teamId: string }[] = [];
      const seen = new Set<string>();
      for (const entry of body.mappings) {
        if (
          !record(entry) ||
          Object.keys(entry).length !== 2 ||
          typeof entry.repository !== "string" ||
          typeof entry.teamId !== "string" ||
          !choices.repositories.some((repo) => repo.repository === entry.repository) ||
          !teams.some((team) => team.id === entry.teamId)
        )
          return reply({ error: "Choose an available repository and Linear team." }, 400);
        const key = `${entry.repository}:${entry.teamId}`;
        if (seen.has(key))
          return reply({ error: "Choose each repository and team only once." }, 400);
        seen.add(key);
        mappings.push({ repository: entry.repository, teamId: entry.teamId });
      }
      const repositories = [...new Set(mappings.map((entry) => entry.repository))].sort();
      await verifyHostedGitHubRepositories({
        app: secret.app,
        user: secret.user,
        installationId: choices.installationId,
        repositories,
        signal,
        fetch: http,
      });
      const currentTeams = await options.teams(request, signal);
      if (mappings.some((entry) => !currentTeams.some((team) => team.id === entry.teamId)))
        return reply({ error: "Linear team access changed. Refresh and try again." }, 409);
      signal.throwIfAborted();
      const activeId = randomUUID();
      activation.save(activeId, { ...secret.app, installationId: choices.installationId });
      let committed = false;
      try {
        const result = immediate(db, () => {
          if (!unchanged(pending, secret)) return denied();
          replaceWorkspaceRepositories(db, {
            workspaceId,
            actorId: userId,
            repositories: mappings,
            now: now(),
          });
          db.run(
            "INSERT INTO workspace_github_connection(workspace_id) VALUES(?) ON CONFLICT DO NOTHING",
            [workspaceId],
          );
          const changed = db.run(
            "UPDATE workspace_github_connection SET generation=generation+1,secret_id=?,actor_id=?,installation_id=?,repositories=? WHERE workspace_id=? AND generation=?",
            [
              activeId,
              userId,
              choices.installationId,
              JSON.stringify(repositories),
              workspaceId,
              pending.expected_generation,
            ],
          );
          if (changed.changes !== 1)
            throw new Error("A newer GitHub connection is active. Refresh and try again.");
          db.run(
            "UPDATE workspace_github_oauth SET expected_generation=?,intent=? WHERE state_hash=?",
            [
              pending.expected_generation + 1,
              JSON.stringify({ kind: KIND, scope: scope() }),
              pending.state_hash,
            ],
          );
          auditWorkspaceAccess(db, {
            workspaceId,
            userId,
            action: "github.connect.activated",
            subject: `${secret.app.appId}:${choices.installationId}:${secret.user!.id}`,
            now: now(),
          });
          enqueueJob(db, { queue: "github.auth.recover", now: now() });
          return reply({ ok: true });
        });
        committed = result.status === 200;
        return result;
      } finally {
        if (!committed) activation.remove(activeId);
      }
    } catch {
      return reply(
        { error: "GitHub setup could not be completed. Refresh or sign in with GitHub again." },
        409,
      );
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reply(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
