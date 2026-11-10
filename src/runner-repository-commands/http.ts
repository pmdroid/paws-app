import type { Database } from "bun:sqlite";
import { z } from "zod";
import { journalCaught } from "../journal";
import { RunnerRepositoryCommandResultSchema } from "../runner-protocol";
import { issueRepositoryCommandGrant, recordRepositoryCommandResult } from "./commands";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const RESULT_BODY_LIMIT = 1_200_000;

export function createRepositoryCommandsHttp(options: { db: Database; now?: () => number }) {
  const now = options.now ?? Date.now;
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const path = /^\/v1\/repository-commands\/([^/]+)\/(grant|result)$/.exec(
      new URL(request.url).pathname,
    );
    if (!path) return null;
    try {
      if (request.method !== "POST") throw new Error("POST is required.");
      const commandId = id.parse(decodeURIComponent(path[1]!));
      if (path[2] === "grant") {
        z.strictObject({}).parse(await body(request, 4096));
        return json(await issueRepositoryCommandGrant(options.db, { runnerId, commandId }, now()));
      }
      const result = RunnerRepositoryCommandResultSchema.parse(
        await body(request, RESULT_BODY_LIMIT),
      );
      return json(
        await recordRepositoryCommandResult(options.db, { runnerId, commandId, result }, now()),
      );
    } catch (error) {
      journalCaught(error, "runner-repository-commands.http", null);
      return json({ error: "Repository command request is denied or invalid." }, 403);
    }
  };
}

async function body(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("JSON is required.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limit) throw new Error("Repository command input is too large.");
  return JSON.parse(new TextDecoder().decode(bytes));
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
