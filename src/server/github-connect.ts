import { discoverGitHubInstallation } from "./github-connect-status";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  createWorkspaceGitHubActivation,
  createGitHubInstallationCheck,
  githubAppAuthorization,
  hash,
  newGitHubOAuthSecret,
  verifyHostedGitHubApp,
  type ActiveGitHubApp,
} from "../auth";
import {
  auditWorkspaceAccess,
  enqueueJob,
  immediate,
  listWorkspaceRepositories,
  workspaceMember,
} from "../db";
import { requestWorkspaceSession, validWorkspaceCsrf } from "../workspace";

const START = "/api/workspaces/github-connect";
const CALLBACK = "/auth/github-app/callback";
type Intent = {
  app: ActiveGitHubApp;
  verifier: string;
  installationId: string;
  repositories: string[];
  scope: string;
};
type Pending = {
  state_hash: string;
  workspace_id: string;
  user_id: string;
  session_hash: string;
  secret_id: string;
  expected_generation: number;
  intent: string;
  expires_at: number;
  status: string;
};

export function createHostedGitHubConnect(options: {
  db: Database;
  home: string;
  env: Record<string, string | undefined>;
  origin: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;
  if (new URL(origin).protocol !== "https:")
    throw new Error("Hosted GitHub connect requires HTTPS.");
  const activation = createWorkspaceGitHubActivation(db, options.home, options.env);
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (![START, CALLBACK].includes(url.pathname)) return null;
    const access = requestWorkspaceSession(db, request, now());
    const selected = url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
    const permitted = () => {
      const current = requestWorkspaceSession(db, request, now());
      const member = access
        ? workspaceMember(db, access.principal.workspaceId, access.principal.userId)
        : null;
      return (
        access &&
        current?.session.tokenHash === access.session.tokenHash &&
        member?.active &&
        ["owner", "admin"].includes(member.role) &&
        now() >= access.principal.authenticatedAt &&
        now() - access.principal.authenticatedAt <= 900000
      );
    };
    const audit = (action: string) =>
      auditWorkspaceAccess(db, {
        workspaceId: access?.principal.workspaceId ?? null,
        userId: access?.principal.userId ?? null,
        action,
        subject: url.pathname,
        now: now(),
      });
    const administrator = () => {
      const member = access
        ? workspaceMember(db, access.principal.workspaceId, access.principal.userId)
        : null;
      return Boolean(member?.active && ["owner", "admin"].includes(member.role));
    };
    const signedIn = () => {
      const current = requestWorkspaceSession(db, request, now());
      return access && current?.session.tokenHash === access.session.tokenHash;
    };
    const denied = () => {
      audit("access.denied");
      return Response.json(
        administrator()
          ? { code: "reauth_required", error: "Sign in again to connect GitHub." }
          : {
              code: "admin_required",
              error: "Ask a workspace admin to install and connect the GitHub App.",
            },
        { status: 403 },
      );
    };
    if (
      url.origin !== origin ||
      (request.headers.has("host") && request.headers.get("host") !== url.host) ||
      !signedIn() ||
      (selected !== null && selected !== access!.principal.workspaceId)
    )
      return denied();
    if (url.pathname === START && request.method === "GET") {
      let app: ActiveGitHubApp;
      try {
        app = activation.template();
      } catch {
        return Response.json(
          { status: "setup_required", canManage: administrator(), requiresSignIn: !permitted() },
          { headers: { "cache-control": "no-store" } },
        );
      }
      const workspaceId = access!.principal.workspaceId;
      const scope = JSON.stringify(listWorkspaceRepositories(db, workspaceId));
      const repositories = [
        ...new Set(listWorkspaceRepositories(db, workspaceId).map((entry) => entry.repository)),
      ];
      try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
        const discovered = await discoverGitHubInstallation(
          app,
          repositories,
          signal,
          options.fetch,
        );
        const connection = db
          .query<
            { secret_id: string | null; installation_id: string | null; repositories: string },
            [string]
          >(
            "SELECT secret_id,installation_id,repositories FROM workspace_github_connection WHERE workspace_id=?",
          )
          .get(workspaceId);
        const expected = repositories.map((name) => name.toLowerCase()).sort();
        const approved: unknown = connection ? JSON.parse(connection.repositories) : null;
        let connected = Boolean(
          connection?.secret_id &&
          connection.installation_id === discovered.installationId &&
          Array.isArray(approved) &&
          JSON.stringify(
            approved
              .map((name: unknown) => (typeof name === "string" ? name.toLowerCase() : null))
              .sort(),
          ) === JSON.stringify(expected),
        );
        if (connected) {
          const check = createGitHubInstallationCheck({
            home: options.home,
            env: options.env,
            fetch: options.fetch,
            resolve: (repository) => activation.resolve(repository),
          });
          for (const repository of repositories)
            if (!(await check(repository, "write", signal))) connected = false;
        }
        if (!signedIn()) return denied();
        if (
          JSON.stringify(listWorkspaceRepositories(db, workspaceId)) !== scope ||
          JSON.stringify(activation.template()) !== JSON.stringify(app)
        )
          return Response.json(
            { error: "Workspace access changed. Refresh to check GitHub again." },
            { status: 409 },
          );
        return Response.json(
          {
            status: !repositories.length
              ? "needs_repositories"
              : !discovered.installed
                ? "needs_installation"
                : !discovered.permissions
                  ? "needs_access"
                  : connected
                    ? "connected"
                    : "needs_connection",
            canManage: administrator(),
            requiresSignIn: !permitted(),
            installationUrl: discovered.installationUrl,
            repositoryCount: repositories.length,
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch {
        if (!signedIn()) return denied();
        return Response.json(
          {
            error:
              "GitHub access could not be checked. Try again or ask a workspace admin to review the App installation.",
          },
          { status: 503 },
        );
      }
    }
    if (!permitted()) return denied();
    if (url.pathname === START) {
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== origin ||
        !validWorkspaceCsrf(request, access!.session)
      )
        return denied();
      const reader = request.body?.getReader();
      if (!reader) return Response.json({ error: "Choose an installation ID." }, { status: 400 });
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 4096) {
          await reader.cancel();
          break;
        }
        chunks.push(next.value);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (length > 4096)
        return Response.json({ error: "Invalid installation intent." }, { status: 400 });
      let installationId: unknown;
      try {
        const input: unknown = JSON.parse(body);
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          Object.keys(input).some((key) => key !== "installationId")
        )
          throw new Error();
        installationId = (input as { installationId?: unknown }).installationId;
        if (
          installationId !== undefined &&
          (typeof installationId !== "string" || !/^[1-9][0-9]{0,19}$/.test(installationId))
        )
          throw new Error();
      } catch {
        return Response.json(
          { error: "The connection request is invalid. Refresh and try again." },
          { status: 400 },
        );
      }
      if (!permitted()) return denied();
      const initialRepositories = listWorkspaceRepositories(db, access!.principal.workspaceId);
      const initialScope = JSON.stringify(initialRepositories);
      let discoveredApp: ActiveGitHubApp | undefined;
      if (installationId === undefined) {
        const repositories = [...new Set(initialRepositories.map((entry) => entry.repository))];
        if (!repositories.length)
          return Response.json(
            { error: "Ask a workspace owner to add repositories first." },
            { status: 409 },
          );
        try {
          discoveredApp = activation.template();
        } catch {
          return Response.json(
            {
              error:
                "Ask the Paws operator to configure the GitHub App on the server, then restart Paws.",
            },
            { status: 503 },
          );
        }
        try {
          const discovered = await discoverGitHubInstallation(
            discoveredApp,
            repositories,
            AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
            options.fetch,
          );
          if (!permitted()) return denied();
          if (
            JSON.stringify(listWorkspaceRepositories(db, access!.principal.workspaceId)) !==
              initialScope ||
            JSON.stringify(activation.template()) !== JSON.stringify(discoveredApp)
          )
            return Response.json(
              { error: "Workspace access changed. Refresh and try again." },
              { status: 409 },
            );
          if (!discovered.installed || !discovered.permissions)
            return Response.json(
              { installationUrl: discovered.installationUrl },
              { headers: { "cache-control": "no-store" } },
            );
          installationId = discovered.installationId;
        } catch {
          if (!permitted()) return denied();
          return Response.json(
            {
              error:
                "GitHub access could not be checked. Try again or ask a workspace admin to review the App installation.",
            },
            { status: 503 },
          );
        }
      }
      if (typeof installationId !== "string")
        return Response.json({ error: "Install the GitHub App first." }, { status: 409 });
      return immediate(db, () => {
        if (!permitted()) return denied();
        const workspaceId = access!.principal.workspaceId;
        const scope = JSON.stringify(listWorkspaceRepositories(db, workspaceId));
        if (scope !== initialScope)
          return Response.json(
            { error: "Workspace access changed. Refresh and try again." },
            { status: 409 },
          );
        const repositories = [
          ...new Set(listWorkspaceRepositories(db, workspaceId).map((entry) => entry.repository)),
        ];
        if (!repositories.length)
          return Response.json(
            { error: "An owner must approve workspace repositories first." },
            { status: 409 },
          );
        let app: ActiveGitHubApp;
        try {
          app = activation.template();
        } catch {
          return Response.json(
            {
              error:
                "Ask the Paws operator to configure the GitHub App on the server, then restart Paws.",
            },
            { status: 503 },
          );
        }
        if (discoveredApp && JSON.stringify(app) !== JSON.stringify(discoveredApp))
          return Response.json(
            { error: "GitHub setup changed. Refresh and try again." },
            { status: 409 },
          );
        const secret = newGitHubOAuthSecret();
        activation.save(secret.id, {
          app,
          verifier: secret.verifier,
          installationId,
          repositories,
          scope,
        } satisfies Intent);
        db.run(
          "INSERT INTO workspace_github_connection(workspace_id) VALUES(?) ON CONFLICT DO NOTHING",
          [workspaceId],
        );
        const generation = db
          .query<{ generation: number }, [string]>(
            "SELECT generation FROM workspace_github_connection WHERE workspace_id=?",
          )
          .get(workspaceId)!.generation;
        db.run(
          "INSERT INTO workspace_github_oauth(state_hash,workspace_id,user_id,session_hash,secret_id,expected_generation,intent,expires_at) VALUES(?,?,?,?,?,?,?,?)",
          [
            hash(secret.state),
            workspaceId,
            access!.principal.userId,
            access!.session.tokenHash,
            secret.id,
            generation,
            JSON.stringify({ appId: app.appId, installationId, scope }),
            now() + 600000,
          ],
        );
        audit("github.connect.started");
        return Response.json(
          {
            authorizationUrl: githubAppAuthorization({
              clientId: app.clientId,
              redirectUri: origin + CALLBACK,
              state: secret.state,
              verifier: secret.verifier,
            }),
          },
          { headers: { "cache-control": "no-store" } },
        );
      });
    }
    if (request.method !== "GET") return denied();
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (
      !state ||
      !code ||
      state.length > 128 ||
      code.length > 4096 ||
      url.searchParams.has("error")
    )
      return denied();
    const pending = immediate(db, () =>
      db
        .query<Pending, [string, string, string, string, number]>(
          "UPDATE workspace_github_oauth SET status='claimed' WHERE state_hash=? AND workspace_id=? AND user_id=? AND session_hash=? AND expires_at>? AND status='pending' RETURNING *",
        )
        .get(
          hash(state),
          access!.principal.workspaceId,
          access!.principal.userId,
          access!.session.tokenHash,
          now(),
        ),
    );
    if (!pending) return denied();
    try {
      const intent = activation.read<Intent>(pending.secret_id);
      const human = await verifyHostedGitHubApp({
        ...intent,
        code,
        redirectUri: origin + CALLBACK,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      const secretId = randomUUID();
      activation.save(secretId, { ...intent.app, installationId: intent.installationId });
      return immediate(db, () => {
        const currentApp = activation.template();
        if (
          currentApp.appId !== intent.app.appId ||
          currentApp.clientId !== intent.app.clientId ||
          currentApp.privateKeyPem !== intent.app.privateKeyPem ||
          !permitted() ||
          pending.expires_at <= now() ||
          JSON.stringify(listWorkspaceRepositories(db, pending.workspace_id)) !== intent.scope
        )
          return denied();
        const changed = db.run(
          "UPDATE workspace_github_connection SET generation=generation+1,secret_id=?,actor_id=?,installation_id=?,repositories=? WHERE workspace_id=? AND generation=?",
          [
            secretId,
            pending.user_id,
            intent.installationId,
            JSON.stringify(intent.repositories),
            pending.workspace_id,
            pending.expected_generation,
          ],
        );
        if (changed.changes !== 1)
          return Response.json(
            { error: "A newer connection is already active. Start again." },
            { status: 409 },
          );
        db.run(
          "UPDATE workspace_github_oauth SET status='complete' WHERE state_hash=? AND status='claimed'",
          [pending.state_hash],
        );
        auditWorkspaceAccess(db, {
          workspaceId: pending.workspace_id,
          userId: pending.user_id,
          action: "github.connect.activated",
          subject: `${intent.app.appId}:${intent.installationId}:${human.id}`,
          now: now(),
        });
        enqueueJob(db, { queue: "github.auth.recover", now: now() });
        return new Response(null, {
          status: 303,
          headers: {
            location: origin + "/status#/settings/integrations",
            "cache-control": "no-store",
          },
        });
      });
    } catch {
      db.run("UPDATE workspace_github_oauth SET status='failed' WHERE state_hash=?", [
        pending.state_hash,
      ]);
      audit("github.connect.failed");
      return Response.json(
        { error: "GitHub connection could not be verified. Start again." },
        { status: 409 },
      );
    }
  };
}
