import { z } from "zod";
import { MAX_TOKEN_TTL_MS, TOKEN_TTL_SKEW_MS, type GitHubApp } from "../github";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";

const inputSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  access: z.enum(["read", "write"]),
});
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export function createRunnerRepositoryAccess(options: {
  work: RunnerWork;
  github: GitHubApp;
  installationForRepository(repository: string): string | null;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const path = /^\/v1\/runs\/([^/]+)\/repository-credential$/.exec(new URL(request.url).pathname);
    if (!path) return null;
    const denied = () =>
      Response.json(
        { error: "Runner repository access is denied." },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    try {
      if (
        request.method !== "POST" ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      )
        return denied();
      const authorization = request.headers.get("authorization");
      if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return denied();
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 4096) return denied();
      const input = inputSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const access = {
        runnerId,
        runId: idSchema.parse(decodeURIComponent(path[1]!)),
        generation: input.generation,
        token: authorization.slice(7),
      };
      const initial = options.work.authorize(access);
      if (!initial.command.repository) return denied();
      if (input.access === "write" && (initial.command.type !== "run" || !initial.branch))
        return denied();
      const repository = `${initial.command.repository.owner}/${initial.command.repository.repo}`;
      const installationId = options.installationForRepository(repository);
      if (!installationId) return denied();
      const credential = await options.github.mintInstallationToken({
        access: input.access,
        repository,
        installationId,
      });
      const current = options.work.authorize(access);
      const checkedAt = now();
      if (
        current.command.id !== initial.command.id ||
        !current.command.repository ||
        current.branch !== initial.branch ||
        credential.repository !== repository ||
        !/^[\x21-\x7e]{1,4096}$/.test(credential.token) ||
        !Number.isFinite(credential.expiresAt) ||
        credential.expiresAt <= checkedAt ||
        credential.expiresAt > checkedAt + MAX_TOKEN_TTL_MS + TOKEN_TTL_SKEW_MS
      )
        return denied();
      return Response.json(
        {
          token: credential.token,
          expiresAt: Math.min(credential.expiresAt, checkedAt + MAX_TOKEN_TTL_MS),
          remoteUrl: current.command.repository.remoteUrl,
          branch: input.access === "write" ? current.branch : null,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof RunnerWorkFencedError)
        return Response.json(
          { error: "Runner work is fenced.", code: "fenced" },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      return denied();
    }
  };
}
