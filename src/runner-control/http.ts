import { journalCaught } from "../journal";
import { z } from "zod";
import { RunnerAgentUpdateError, RunnerConcurrencyError } from "../db";
import { RUNNER_CODING_AGENTS, RunnerAgentVersionSchema } from "../runner-protocol";
import type { RunnerPeer } from "../runner-identity";
import type { WorkspacePrincipal } from "../workspace";
import { RunnerEnrollmentDenied, type RunnerControl } from "./control";

const hostEnrollment = z
  .object({
    token: z
      .string()
      .min(16)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    name: z.string().max(80),
    csr: z.string().max(16_384),
  })
  .strict();
const enrollmentRequest = z.object({ name: z.string().max(80) }).strict();
const certificate = z.object({ csr: z.string().max(16_384) }).strict();
const runnerStatus = z
  .object({ status: z.enum(["active", "paused", "draining", "revoked"]) })
  .strict();
const runnerConcurrency = z.object({ concurrency: z.number().int().min(1).max(16) }).strict();
const agentUpdate = z.object({ version: RunnerAgentVersionSchema }).strict();
const agentNames = RUNNER_CODING_AGENTS.join("|");
const agentPath = new RegExp(
  `^/api/runners/([0-9A-HJKMNP-TV-Z]{26})/coding-agents/(${agentNames})/update$`,
);

export type RunnerHostConfig = {
  controlPlaneUrl: string;
  runnerApiUrl: string;
  allowedRepositories: readonly string[];
};

export function createRunnerHttp(
  control: RunnerControl,
  options: {
    /** Per-agent sign-in status added to each runner in the list. */
    agents?: (principal: WorkspacePrincipal, runnerId: string) => readonly unknown[];
    /** What a new host's config needs: this Paws's endpoints and the repositories it may run. */
    hostConfig?: () => RunnerHostConfig | null;
  } = {},
) {
  let enrolling = 0;
  return {
    /**
     * `POST /api/runner-enrollments`: the host posts its token, name and CSR once and receives
     * its identity. A used, expired or unknown token answers 401.
     */
    async hostEnrollment(request: Request): Promise<Response> {
      if (new URL(request.url).protocol !== "https:")
        return json({ error: "HTTPS is required." }, 400);
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      if (enrolling >= 4) return json({ error: "Enrollment is busy. Try again shortly." }, 429);
      enrolling += 1;
      try {
        const parsed = hostEnrollment.safeParse(
          await readJson(request).catch((caughtError2) => {
            journalCaught(caughtError2, "http.hostEnrollment.readJson", null);
            return undefined;
          }),
        );
        if (!parsed.success) return json({ error: "Runner enrollment request is invalid." }, 400);
        return json(await control.enroll(parsed.data));
      } catch (error) {
        journalCaught(error, "http.hostEnrollment.safeParse", null);
        if (error instanceof RunnerEnrollmentDenied)
          return json({ error: "Runner enrollment token is invalid or expired." }, 401);
        return json({ error: "Runner enrollment request is invalid or unavailable." }, 400);
      } finally {
        enrolling -= 1;
      }
    },
    async browser(request: Request, principal: WorkspacePrincipal): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      try {
        if (path === "/api/runners" && request.method === "GET")
          return json({
            runners: control
              .list(principal)
              .map((runner) =>
                options.agents
                  ? { ...runner, agents: options.agents(principal, runner.id) }
                  : runner,
              ),
            serverVersion: control.serverVersion(),
            agentVersions: control.agentVersions(),
          });
        if (path === "/api/runners/enrollments" && request.method === "POST")
          return json({
            ...control.createEnrollment(
              principal,
              enrollmentRequest.parse(await readJson(request)),
            ),
            config: options.hostConfig?.() ?? null,
          });
        const match = /^\/api\/runners\/([0-9A-HJKMNP-TV-Z]{26})\/status$/.exec(path);
        if (match && request.method === "POST") {
          control.setStatus(
            principal,
            match[1]!,
            runnerStatus.parse(await readJson(request)).status,
          );
          return json({ ok: true });
        }
        const concurrency = /^\/api\/runners\/([0-9A-HJKMNP-TV-Z]{26})\/concurrency$/.exec(path);
        if (concurrency && request.method === "POST") {
          control.setConcurrency(
            principal,
            concurrency[1]!,
            runnerConcurrency.parse(await readJson(request)).concurrency,
          );
          return json({ ok: true });
        }
        if (path === "/api/runners/coding-agents/update-all" && request.method === "POST")
          return json({ requested: control.updateAllAgents(principal) });
        const agent = agentPath.exec(path);
        if (agent && request.method === "POST") {
          const [, runnerId, name] = agent;
          const { version } = agentUpdate.parse(await readJson(request));
          control.updateAgent(principal, runnerId!, name!, version);
          return json({ ok: true, version });
        }
        return null;
      } catch (error) {
        journalCaught(error, "http.browser.json", null);
        if (error instanceof RunnerConcurrencyError || error instanceof RunnerAgentUpdateError)
          return json({ error: error.message }, 400);
        return json({ error: "Runner access denied or request is invalid." }, 403);
      }
    },
    async runner(request: Request, peer: RunnerPeer): Promise<Response | null> {
      if (new URL(request.url).pathname !== "/v1/certificate") return null;
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      try {
        const input = certificate.parse(await readJson(request));
        return json(await control.renew(peer, input.csr));
      } catch (caughtError3) {
        journalCaught(caughtError3, "http.runner.parse", null);
        return json({ error: "Runner certificate renewal denied." }, 403);
      }
    },
  };
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("JSON is required.");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 24_576))
    throw new Error("Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required.");
  const timeout = AbortSignal.timeout(10_000);
  const cancel = () =>
    void reader.cancel().catch((caughtError4) => {
      journalCaught(caughtError4, "http.readJson.cancel", null);
    });
  timeout.addEventListener("abort", cancel, { once: true });
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      timeout.throwIfAborted();
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 24_576) throw new Error("Request is too large.");
      chunks.push(next.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch((caughtError5) => {
      journalCaught(caughtError5, "http.readJson.cancel", null);
    });
    reader.releaseLock();
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
