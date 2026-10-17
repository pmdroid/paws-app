import { z } from "zod";
import type { RunnerPeer } from "../runner-identity";
import type { WorkspacePrincipal } from "../workspace";
import type { RunnerControl } from "./pairing";

const code = z.object({ code: z.string().regex(/^[A-F0-9]{16}$/) }).strict();
const enrollment = z.union([
  z.object({ name: z.string().max(80), csr: z.string().max(16_384) }).strict(),
  z.object({ id: z.string().max(80), claim: z.string().max(80) }).strict(),
]);
const certificate = z.object({ csr: z.string().max(16_384) }).strict();
const runnerStatus = z
  .object({ status: z.enum(["active", "paused", "draining", "revoked"]) })
  .strict();

export function createRunnerHttp(control: RunnerControl) {
  let enrolling = 0;
  return {
    async enrollment(request: Request): Promise<Response> {
      if (new URL(request.url).protocol !== "https:")
        return json({ error: "HTTPS is required." }, 400);
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      if (enrolling >= 4) return json({ error: "Pairing is busy. Try again shortly." }, 429);
      enrolling += 1;
      try {
        const input = enrollment.parse(await readJson(request));
        return json(
          "id" in input
            ? control.claimPairing(input.id, input.claim)
            : await control.beginPairing(input),
        );
      } catch {
        return json({ error: "Runner pairing request is invalid or unavailable." }, 400);
      } finally {
        enrolling -= 1;
      }
    },
    async browser(request: Request, principal: WorkspacePrincipal): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      try {
        if (path === "/api/runners" && request.method === "GET")
          return json({ runners: control.list(principal), serverVersion: control.serverVersion() });
        if (path === "/api/runners/pairings/inspect" && request.method === "POST")
          return json(control.inspectPairing(principal, code.parse(await readJson(request)).code));
        if (path === "/api/runners/pairings/approve" && request.method === "POST")
          return json(
            await control.approvePairing(principal, code.parse(await readJson(request)).code),
          );
        const match = /^\/api\/runners\/([0-9A-HJKMNP-TV-Z]{26})\/status$/.exec(path);
        if (match && request.method === "POST") {
          control.setStatus(
            principal,
            match[1]!,
            runnerStatus.parse(await readJson(request)).status,
          );
          return json({ ok: true });
        }
        return null;
      } catch {
        return json({ error: "Runner access denied or request is invalid." }, 403);
      }
    },
    async runner(request: Request, peer: RunnerPeer): Promise<Response | null> {
      if (new URL(request.url).pathname !== "/v1/certificate") return null;
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      try {
        const input = certificate.parse(await readJson(request));
        return json(await control.renew(peer, input.csr));
      } catch {
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
  const cancel = () => void reader.cancel().catch(() => {});
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
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
