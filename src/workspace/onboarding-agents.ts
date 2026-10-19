import type { Database } from "bun:sqlite";
import { immediate, type WorkspaceSession } from "../db";
import type { RunnerLogin } from "../runner-login";
import type { RunnerHealth } from "../runner-health";
import { RunnerLoginInputSchema } from "../runner-protocol";
import type { WorkspaceAssignments } from "./assignments";
import { onboardingVmState } from "./onboarding-vm";
import { readWorkspaceJson } from "./administration";
import { validWorkspaceCsrf, type WorkspacePrincipal } from "./session";

export type OnboardingAgents = {
  login: Pick<RunnerLogin, "list" | "start" | "browser">;
  health: Pick<RunnerHealth, "agents">;
};

type Context = { session: string; generation: number };

export function onboardingAgentsState(
  db: Database,
  assignments: Pick<WorkspaceAssignments, "onboardingContext">,
  dependencies: OnboardingAgents,
  principal: WorkspacePrincipal,
  context: Context,
  now: number,
) {
  const scope = assignments.onboardingContext(context.session, context.generation, principal);
  if (!scope) return null;
  const runner = onboardingVmState(db, scope, now).selectedRunner;
  const accounts = runner ? dependencies.login.list(principal, runner.id).accounts : [];
  const health = runner ? dependencies.health.agents(principal, runner.id) : [];
  const agents = (["claude", "codex"] as const).map((agent) => {
    const account = accounts.find((entry) => entry.agent === agent);
    const check = health.find((entry) => entry.agent === agent);
    const connected = account?.connected === true && check?.status === "signed_in";
    return {
      agent,
      state: connected
        ? "connected"
        : check?.status === "signed_out"
          ? "signed_out"
          : account?.connected
            ? (check?.status ?? "unknown")
            : account?.session?.state === "connected"
              ? "signed_out"
              : (account?.session?.state ?? "signed_out"),
      updatedAt: account?.updatedAt ?? null,
      checkedAt: check?.checkedAt ?? null,
    };
  });
  return {
    runner,
    agents,
    ready: runner !== null && agents.every((agent) => agent.state === "connected"),
  };
}

export async function handleOnboardingAgents(
  request: Request,
  options: {
    db: Database;
    assignments: Pick<WorkspaceAssignments, "onboardingContext">;
    dependencies: OnboardingAgents;
    challenges: Map<string, { binding: string; expiresAt: number }>;
    principal: WorkspacePrincipal;
    session: WorkspaceSession;
    origin: string;
    now: () => number;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  const match =
    /^\/api\/workspaces\/onboarding\/agents(?:\/(claude|codex)\/login(?:\/([a-f0-9-]{36})(\/input)?)?)?$/.exec(
      url.pathname,
    );
  if (!match) return null;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const mutation = request.method !== "GET";
  if (
    mutation &&
    (request.headers.get("origin") !== options.origin ||
      !validWorkspaceCsrf(request, options.session))
  )
    return json({ error: "CSRF token required." }, 403);
  const agent = match[1] as "claude" | "codex" | undefined;
  const id = match[2];
  const input = match[3];
  if (
    (!agent && request.method !== "GET") ||
    (agent && !id && !["GET", "POST"].includes(request.method)) ||
    (id && !input && !["GET", "DELETE"].includes(request.method)) ||
    (input && request.method !== "POST")
  )
    return json({ error: "Method not allowed" }, 405);
  const body = mutation
    ? await readWorkspaceJson(request).catch(() => null)
    : Object.fromEntries(url.searchParams);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ error: "Invalid agent request." }, 400);
  const value = body as Record<string, unknown>;
  const keys = agent
    ? input
      ? "generation,input,runnerId,session"
      : !mutation && !id
        ? "generation,loginId,runnerId,session"
        : "generation,runnerId,session"
    : "generation,session";
  if (
    Object.keys(value).sort().join(",") !== keys ||
    typeof value.session !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.session)
  )
    return json({ error: "Invalid assignment." }, 400);
  if (
    !mutation &&
    (typeof value.generation !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(value.generation))
  )
    return json({ error: "Invalid generation." }, 400);
  if (
    agent &&
    !id &&
    !mutation &&
    (typeof value.loginId !== "string" || !/^[a-f0-9-]{36}$/.test(value.loginId))
  )
    return json({ error: "Invalid private session." }, 400);
  const generation = mutation ? value.generation : Number(value.generation);
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation > 9_999_999_999
  )
    return json({ error: "Invalid generation." }, 400);
  const context = { session: value.session, generation };
  const state = () =>
    onboardingAgentsState(
      options.db,
      options.assignments,
      options.dependencies,
      options.principal,
      context,
      options.now(),
    );
  const selected = () => {
    const current = state();
    if (!current) throw new Error("Assignment unavailable");
    if (!current.runner || current.runner.id !== value.runnerId) throw new Error("VM changed");
    return current.runner;
  };
  const initial = state();
  if (!initial) return json({ error: "Onboarding is unavailable." }, 404);
  if (!agent) return json(initial);
  if (!initial.runner || initial.runner.id !== value.runnerId)
    return json({ error: "Select your current VM." }, 409);
  if (input && !RunnerLoginInputSchema.safeParse(value.input).success)
    return json({ error: "Invalid sign-in input." }, 400);
  try {
    return await immediate(options.db, () => {
      const runner = selected();
      const binding = JSON.stringify([
        options.principal.workspaceId,
        options.principal.userId,
        context.session,
        context.generation,
        runner.id,
        agent,
      ]);
      for (const [key, challenge] of options.challenges)
        if (challenge.expiresAt <= options.now()) options.challenges.delete(key);
      if (!id && request.method === "POST") {
        const existing = initial.agents.find((entry) => entry.agent === agent);
        const account = options.dependencies.login
          .list(options.principal, runner.id)
          .accounts.find((entry) => entry.agent === agent);
        if (account?.connected && existing?.state !== "signed_out")
          return json({ agent, state: existing?.state ?? "unknown" });
        const challenge = options.dependencies.login.start(options.principal, runner.id, agent);
        const previous = options.challenges.get(challenge.id);
        if (previous && previous.binding !== binding)
          return json(
            { error: "Finish the existing sign-in before starting another assignment." },
            409,
          );
        options.challenges.set(challenge.id, { binding, expiresAt: challenge.expiresAt });
        return json(challenge);
      }
      const loginId = id ?? url.searchParams.get("loginId");
      if (!loginId) return json({ error: "Choose a private sign-in session." }, 400);
      if (options.challenges.get(loginId)?.binding !== binding)
        return json({ error: "Private sign-in is unavailable." }, 404);
      const target = new URL(
        `/api/runners/${runner.id}/accounts/${agent}/login/${loginId}${input ? "/input" : ""}`,
        options.origin,
      );
      return options.dependencies.login.browser(
        new Request(target.href, {
          method: request.method,
          ...(input
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(value.input) }
            : {}),
        }),
        options.principal,
        () => {
          selected();
        },
      );
    });
  } catch {
    return json({ error: "Agent sign-in is unavailable." }, 403);
  }
}
