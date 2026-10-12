import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRunnerCheckBrokerClient,
  type RunnerCheckBrokerClient,
} from "../src/runner-execution";

const id = "01K00000000000000000000001";

async function broker(
  reply: (request: { operation: string; executionId: string }) => Promise<string> | string,
  exercise: (client: RunnerCheckBrokerClient) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "paws-check-broker-wire-"));
  const socketPath = join(root, "broker.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", async (chunk) => {
      input += chunk.toString();
      if (input.endsWith("\n")) socket.end(await reply(JSON.parse(input)));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await exercise(createRunnerCheckBrokerClient({ socketPath }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test("check broker uses fixed operations, preserves admission receipts and joins stop", async () => {
  const requests: unknown[] = [];
  let stopped = false;
  await broker(
    async (request) => {
      requests.push(request);
      if (request.operation === "start-check")
        return JSON.stringify({ ok: true, alreadyAdmitted: requests.length > 1 }) + "\n";
      await Bun.sleep(20);
      stopped = true;
      return '{"ok":true}\n';
    },
    async (client) => {
      expect(await client.startCheck(id)).toEqual({ alreadyAdmitted: false });
      expect(await client.startCheck(id)).toEqual({ alreadyAdmitted: true });
      await client.stopCheck(id);
      expect(stopped).toBe(true);
      expect(() => client.startCheck("../../other.service")).toThrow();
    },
  );
  expect(requests).toEqual([
    { operation: "start-check", executionId: id },
    { operation: "start-check", executionId: id },
    { operation: "stop-check", executionId: id },
  ]);
});

test("check broker rejects malformed framing and ambiguous admission or stop receipts", async () => {
  for (const response of [
    '{"ok":true}\n',
    '{"ok":true,"alreadyAdmitted":"yes"}\n',
    '{"ok":true,"alreadyAdmitted":false,"extra":true}\n',
    '{"ok":true,"alreadyAdmitted":false}\ntrailing',
    "x".repeat(1025),
  ])
    await broker(
      () => response,
      async (client) => {
        await expect(client.startCheck(id)).rejects.toThrow();
      },
    );
  await broker(
    () => '{"ok":true,"alreadyAdmitted":false}\n',
    async (client) => {
      await expect(client.stopCheck(id)).rejects.toThrow();
    },
  );
});
