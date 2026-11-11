import {
  workspaceMemberUsable,
  advanceGithubConnectionSteps,
  auditWorkspaceAccessSteps,
  claimGithubOAuthSteps,
  completeGithubOAuthSteps,
  emitJobReady,
  enqueueJobSteps,
  ensureGithubConnectionSteps,
  failGithubOAuthSteps,
  githubConnectionSteps,
  insertGithubOAuthSteps,
  latestGitHubDeliverySteps,
  listWorkspaceRepositoriesSteps,
  type Db,
  workspaceMemberSteps,
  type Q,
  type Steps,
} from "../db";
import { isWorkspaceAdmin, requestWorkspaceSessionSteps, validWorkspaceCsrf } from "../workspace";
import { journalCaught } from "../journal";
import { discoverGitHubInstallation } from "./github-connect-status";
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
import { dashboardUrl } from "../dashboard-links";

const START = "/api/workspaces/github-connect";
const CALLBACK = "/auth/github-app/callback";
type Intent = {
  app: ActiveGitHubApp;
  verifier: string;
  installationId: string;
  repositories: string[];
  scope: string;
};
export function createHostedGitHubConnect(options: {
  store: Db;
  home: string;
  env: Record<string, string | undefined>;
  origin: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;
  if (new URL(origin).protocol !== "https:")
    throw new Error("Hosted GitHub connect requires HTTPS.");
  const activation = createWorkspaceGitHubActivation(store, options.home, options.env);
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (![START, CALLBACK].includes(url.pathname)) return null;
    const access = await store.run((q) => requestWorkspaceSessionSteps(q, request, now()));
    const selected = url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
    function* permittedSteps(q: Q) {
      const current = yield* requestWorkspaceSessionSteps(q, request, now());
      const member = access
        ? yield* workspaceMemberSteps(q, access.principal.workspaceId, access.principal.userId)
        : null;
      return Boolean(
        access &&
        current?.session.tokenHash === access.session.tokenHash &&
        workspaceMemberUsable(member) &&
        isWorkspaceAdmin(member.role),
      );
    }
    const permitted = () => store.run(permittedSteps);
    const auditSteps = (q: Q, action: string) =>
      auditWorkspaceAccessSteps(q, {
        workspaceId: access?.principal.workspaceId ?? null,
        userId: access?.principal.userId ?? null,
        action,
        subject: url.pathname,
        now: now(),
      });
    const audit = (action: string) => store.run((q) => auditSteps(q, action));
    function* administratorSteps(q: Q) {
      const member = access
        ? yield* workspaceMemberSteps(q, access.principal.workspaceId, access.principal.userId)
        : null;
      return Boolean(workspaceMemberUsable(member) && isWorkspaceAdmin(member.role));
    }
    const administrator = () => store.run(administratorSteps);
    const signedIn = async () => {
      const current = await store.run((q) => requestWorkspaceSessionSteps(q, request, now()));
      return access && current?.session.tokenHash === access.session.tokenHash;
    };
    function* deniedSteps(q: Q): Steps<Response> {
      yield* auditSteps(q, "access.denied");
      return Response.json(
        (yield* administratorSteps(q))
          ? { code: "reauth_required", error: "Sign in again to connect GitHub." }
          : {
              code: "admin_required",
              error: "Ask a workspace admin to install and connect the GitHub App.",
            },
        { status: 403 },
      );
    }
    const denied = () => store.run(deniedSteps);
    const repositoriesOf = (workspaceId: string) =>
      store.run((q) => listWorkspaceRepositoriesSteps(q, workspaceId));
    if (
      url.origin !== origin ||
      (request.headers.has("host") && request.headers.get("host") !== url.host) ||
      !(await signedIn()) ||
      (selected !== null && selected !== access!.principal.workspaceId)
    )
      return denied();
    if (url.pathname === START && request.method === "GET") {
      let app: ActiveGitHubApp;
      try {
        app = activation.template();
      } catch (caughtError1) {
        journalCaught(caughtError1, "github-connect.createHostedGitHubConnect.template", null);
        return Response.json(
          {
            status: "setup_required",
            canManage: await administrator(),
            requiresSignIn: !(await permitted()),
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
      const workspaceId = access!.principal.workspaceId;
      const scope = JSON.stringify(await repositoriesOf(workspaceId));
      const repositories = [
        ...new Set((await repositoriesOf(workspaceId)).map((entry) => entry.repository)),
      ];
      try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
        const discovered = await discoverGitHubInstallation(
          app,
          repositories,
          signal,
          options.fetch,
        );
        const connection = await store.run((q) => githubConnectionSteps(q, workspaceId));
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
        if (!(await signedIn())) return await denied();
        if (
          JSON.stringify(await repositoriesOf(workspaceId)) !== scope ||
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
            canManage: await administrator(),
            requiresSignIn: !(await permitted()),
            installationUrl: discovered.installationUrl,
            repositoryCount: repositories.length,
            lastDelivery: await store.run(latestGitHubDeliverySteps),
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (caughtError2) {
        journalCaught(caughtError2, "github-connect.createHostedGitHubConnect.any", null);
        if (!(await signedIn())) return denied();
        return Response.json(
          {
            error:
              "GitHub access could not be checked. Try again or ask a workspace admin to review the App installation.",
          },
          { status: 503 },
        );
      }
    }
    if (!(await permitted())) return denied();
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
      } catch (caughtError3) {
        journalCaught(caughtError3, "github-connect.createHostedGitHubConnect.parse", null);
        return Response.json(
          { error: "The connection request is invalid. Refresh and try again." },
          { status: 400 },
        );
      }
      if (!(await permitted())) return denied();
      const initialRepositories = await repositoriesOf(access!.principal.workspaceId);
      const initialScope = JSON.stringify(initialRepositories);
      let discoveredApp: ActiveGitHubApp | undefined;
      if (installationId === undefined) {
        const repositories = [...new Set(initialRepositories.map((entry) => entry.repository))];
        if (!repositories.length)
          return Response.json(
            { error: "Ask a workspace admin to add repositories first." },
            { status: 409 },
          );
        try {
          discoveredApp = activation.template();
        } catch (caughtError4) {
          journalCaught(caughtError4, "github-connect.createHostedGitHubConnect.template", null);
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
          if (!(await permitted())) return await denied();
          if (
            JSON.stringify(await repositoriesOf(access!.principal.workspaceId)) !== initialScope ||
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
        } catch (caughtError5) {
          journalCaught(
            caughtError5,
            "github-connect.createHostedGitHubConnect.discoverGitHubInstallation",
            null,
          );
          if (!(await permitted())) return denied();
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
      return store.transaction(function* (q) {
        if (!(yield* permittedSteps(q))) return yield* deniedSteps(q);
        const workspaceId = access!.principal.workspaceId;
        const scope = JSON.stringify(yield* listWorkspaceRepositoriesSteps(q, workspaceId));
        if (scope !== initialScope)
          return Response.json(
            { error: "Workspace access changed. Refresh and try again." },
            { status: 409 },
          );
        const repositories = [
          ...new Set(
            (yield* listWorkspaceRepositoriesSteps(q, workspaceId)).map(
              (entry) => entry.repository,
            ),
          ),
        ];
        if (!repositories.length)
          return Response.json(
            { error: "An owner must approve workspace repositories first." },
            { status: 409 },
          );
        let app: ActiveGitHubApp;
        try {
          app = activation.template();
        } catch (caughtError6) {
          journalCaught(caughtError6, "github-connect.createHostedGitHubConnect.template", null);
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
        yield* ensureGithubConnectionSteps(q, workspaceId);
        const generation = (yield* githubConnectionSteps(q, workspaceId))!.generation;
        yield* insertGithubOAuthSteps(q, {
          stateHash: hash(secret.state),
          workspaceId,
          userId: access!.principal.userId,
          sessionHash: access!.session.tokenHash,
          secretId: secret.id,
          expectedGeneration: generation,
          intent: JSON.stringify({ appId: app.appId, installationId, scope }),
          expiresAt: now() + 600000,
        });
        yield* auditSteps(q, "github.connect.started");
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
    const requester = {
      workspaceId: access!.principal.workspaceId,
      userId: access!.principal.userId,
      sessionHash: access!.session.tokenHash,
    };
    const pending = await store.transaction((q) =>
      claimGithubOAuthSteps(q, hash(state), requester, now()),
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
      const job = { ready: false };
      const response = await store.transaction(function* (q) {
        const currentApp = activation.template();
        if (
          currentApp.appId !== intent.app.appId ||
          currentApp.clientId !== intent.app.clientId ||
          currentApp.privateKeyPem !== intent.app.privateKeyPem ||
          !(yield* permittedSteps(q)) ||
          pending.expires_at <= now() ||
          JSON.stringify(yield* listWorkspaceRepositoriesSteps(q, pending.workspace_id)) !==
            intent.scope
        )
          return yield* deniedSteps(q);
        if (
          !(yield* advanceGithubConnectionSteps(q, {
            workspaceId: pending.workspace_id,
            expectedGeneration: pending.expected_generation,
            secretId,
            actorId: pending.user_id,
            installationId: intent.installationId,
            repositories: intent.repositories,
          }))
        )
          return Response.json(
            { error: "A newer connection is already active. Start again." },
            { status: 409 },
          );
        yield* completeGithubOAuthSteps(q, pending.state_hash);
        yield* auditWorkspaceAccessSteps(q, {
          workspaceId: pending.workspace_id,
          userId: pending.user_id,
          action: "github.connect.activated",
          subject: `${intent.app.appId}:${intent.installationId}:${human.id}`,
          now: now(),
        });
        yield* enqueueJobSteps(q, { queue: "github.auth.recover", now: now() });
        job.ready = true;
        return new Response(null, {
          status: 303,
          headers: {
            location: dashboardUrl(origin, "/settings/integrations"),
            "cache-control": "no-store",
          },
        });
      });
      if (job.ready) emitJobReady(store);
      return response;
    } catch (caughtError7) {
      journalCaught(caughtError7, "github-connect.createHostedGitHubConnect.read", null);
      await store.run((q) => failGithubOAuthSteps(q, pending.state_hash, false));
      await audit("github.connect.failed");
      return Response.json(
        { error: "GitHub connection could not be verified. Start again." },
        { status: 409 },
      );
    }
  };
}
