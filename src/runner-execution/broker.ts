import { createConnection } from "node:net";
import { ExecutionIdSchema } from "./jobs";

export interface RunnerBrokerClient {
  start(executionId: string): Promise<{ alreadyAdmitted: boolean }>;
  stop(executionId: string): Promise<void>;
}

function createBrokerRequest(options: { socketPath?: string } = {}) {
  const socketPath = options.socketPath ?? "/run/paws-runner-broker.sock";
  function request(
    operation: "start" | "stop",
    executionId: string,
  ): Promise<{ alreadyAdmitted: boolean }> {
    ExecutionIdSchema.parse(executionId);
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let response = "";
      const timer = setTimeout(
        () => socket.destroy(new Error("Runner broker timed out")),
        operation.startsWith("start") ? 120_000 : 60_000,
      );
      socket.on("connect", () => socket.write(`${JSON.stringify({ operation, executionId })}\n`));
      let settled = false;
      function fail(error: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
        socket.destroy();
      }
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        response += chunk.toString("utf8");
        if (Buffer.byteLength(response) > 1024) {
          fail(new Error("Invalid runner broker response"));
          return;
        }
        const newline = response.indexOf("\n");
        if (newline < 0) return;
        try {
          if (newline !== response.length - 1) throw new Error("Invalid runner broker response");
          const value: unknown = JSON.parse(response);
          if (
            value === null ||
            typeof value !== "object" ||
            (value as { ok?: unknown }).ok !== true
          )
            throw new Error("Runner broker rejected request");
          let alreadyAdmitted = false;
          if (operation.startsWith("start")) {
            if (
              Object.keys(value).sort().join() !== "alreadyAdmitted,ok" ||
              typeof (value as { alreadyAdmitted?: unknown }).alreadyAdmitted !== "boolean"
            )
              throw new Error("Invalid runner broker response");
            alreadyAdmitted = (value as { alreadyAdmitted: boolean }).alreadyAdmitted;
          } else if (Object.keys(value).join() !== "ok") {
            throw new Error("Invalid runner broker response");
          }
          settled = true;
          clearTimeout(timer);
          resolve({ alreadyAdmitted });
          socket.destroy();
        } catch {
          fail(new Error("Runner broker rejected request"));
        }
      });
      socket.on("error", fail);
      socket.on("close", () => {
        if (!settled) fail(new Error("Runner broker closed before acknowledgement"));
      });
    });
  }
  return request;
}

export function createRunnerBrokerClient(
  options: { socketPath?: string } = {},
): RunnerBrokerClient {
  const request = createBrokerRequest(options);
  return {
    start: (id) => request("start", id),
    stop: async (id) => {
      await request("stop", id);
    },
  };
}
