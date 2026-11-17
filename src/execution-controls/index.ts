import type { CommandBus } from "../core";
import type { Db } from "../db";
import { journalCaught } from "../journal";
import type { WorkspacePrincipal } from "../workspace";
import {
  createExecutionControlsCore,
  type ExecutionControlPort,
  type ExecutionControlResult,
} from "./core";

export type {
  CanAct,
  ExecutionControlCaller,
  ExecutionControlPort,
  ExecutionControlRequest,
  ExecutionControlResult,
  ExecutionControlView,
  ExecutionControlsCore,
  OnCommitted,
} from "./core";

const REFUSALS: Record<
  Exclude<ExecutionControlResult["status"], "applied">,
  { status: number; error: string }
> = {
  denied: { status: 403, error: "This item is not available to your workspace membership." },
  invalid_target: {
    status: 400,
    error: "Send the dead delivery to retry as outbox:<id> or job:<id>.",
  },
  stale_delivery: {
    status: 409,
    error:
      "This delivery is no longer stopped, or belongs to an earlier state of the issue. Refresh the run.",
  },
  not_ready: { status: 503, error: "Execution controls are not ready. Try again." },
  admin_only: { status: 403, error: "Only a workspace admin can clear a stuck agent." },
  unavailable: { status: 409, error: "This action is no longer available. Refresh the run." },
  unconfirmed: {
    status: 503,
    error: "Execution cleanup could not be confirmed. Refresh the run.",
  },
  changed: { status: 409, error: "The item changed. Refresh the run and try again." },
};

function respond(result: ExecutionControlResult): Response {
  if (result.status === "applied")
    return Response.json({ applied: true, itemId: result.itemId, action: result.action });
  const refusal = REFUSALS[result.status];
  return Response.json({ error: refusal.error }, { status: refusal.status });
}

export function createExecutionControls(input: {
  db: Db;
  bus: CommandBus;
  getPort: (workspaceId: string) => ExecutionControlPort | null;
  now?: () => number;
}) {
  const core = createExecutionControlsCore(input);
  return {
    core,
    async handle(
      request: Request,
      principal: WorkspacePrincipal,
      sessionIds: readonly string[],
    ): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname !== "/api/execution-controls") return null;
      if (request.method !== "GET" && request.method !== "POST")
        return Response.json({ error: "Use GET or POST." }, { status: 405 });
      const caller = { principal, sessionIds };
      if (request.method === "GET") {
        const itemId = url.searchParams.get("itemId");
        const headers = { "Cache-Control": "no-store" };
        if (itemId === null)
          return Response.json({ available: true, itemId, actions: [] }, { headers });
        const { available, actions, notice } = await core.read(caller, itemId);
        return Response.json(
          { available, itemId, actions, ...(notice ? { notice } : {}) },
          { headers },
        );
      }
      let body: Record<string, unknown>;
      try {
        const reader = request.body?.getReader();
        if (!reader || !request.headers.get("content-type")?.startsWith("application/json"))
          throw new Error();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(part.value);
        }
        body = JSON.parse(await new Blob(chunks).text());
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => !["itemId", "action", "target"].includes(key))
        )
          throw new Error();
      } catch (caughtError1) {
        journalCaught(caughtError1, "execution-controls.handle.getReader", null);
        return Response.json(
          { error: "Send an itemId and action as bounded JSON." },
          { status: 400 },
        );
      }
      const { itemId, action } = body;
      if (action === "retry") return respond(await core.retry(caller, body["target"]));
      return respond(
        await core.apply(caller, {
          itemId: typeof itemId === "string" ? itemId : "",
          action: typeof action === "string" ? action : "",
        }),
      );
    },
  };
}
