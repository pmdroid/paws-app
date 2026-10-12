import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const purpose = process.argv[2];
const evidence = process.argv[3];
const behavior = process.argv[5];
const sessionId = `brief-${crypto.randomUUID()}`;
let model = process.argv[4] === "reviewer" ? "test-codex-model" : "test-claude-model";
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [{ value: model, name: model }],
  },
];
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: { cwd?: string; value?: string; prompt?: Array<{ type: string; text?: string }> };
  };
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
  } else if (message.method === "session/new") {
    if (message.params?.cwd) process.chdir(message.params.cwd);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: configOptions() } });
  } else if (message.method === "session/set_config_option") {
    if (message.params?.value) model = message.params.value;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions() } });
  } else if (message.method === "session/prompt") {
    const prompt = message.params?.prompt?.map((block) => block.text ?? "").join("\n") ?? "";
    if (evidence) appendFileSync(evidence, `${JSON.stringify({ purpose, prompt })}\n`);
    if (behavior === "hang") {
      for (const [sessionUpdate, text] of [
        ["agent_message_chunk", "PUBLIC_OBSERVATION"],
        ["agent_thought_chunk", "PRIVATE_HIDDEN"],
      ])
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } },
        });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "observed",
            title: "Observed tool",
            status: "completed",
            rawOutput: { result: "PUBLIC_TOOL_RESULT" },
          },
        },
      });
      if (purpose === "implement") {
        const descendant = spawn(
          process.execPath,
          [
            "-e",
            `const fs = require('fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(evidence + ".descendant")},String(process.pid)); setInterval(()=>fs.appendFileSync('old-writes.txt','x'),5)`,
          ],
          { stdio: "ignore" },
        );
        descendant.unref();
      }
      continue;
    }
    const value = /Required output: `([^`]+)`/.exec(prompt)?.[1] ?? "missing-brief";
    if (purpose === "implement" || purpose === "fix") {
      writeFileSync("result.txt", purpose === "fix" ? `${value}-fixed` : value);
      if (purpose === "fix") {
        execFileSync("git", ["add", "result.txt"]);
        execFileSync("git", [
          "-c",
          "user.name=Paws Test",
          "-c",
          "user.email=paws@example.com",
          "commit",
          "-m",
          "Apply brief-driven fix",
        ]);
      }
    } else {
      const findings =
        readFileSync("result.txt", "utf8") === `${value}-fixed`
          ? []
          : [
              {
                severity: "P1",
                location: "result.txt",
                explanation: "Append the required fixed suffix.",
                evidence: "The result lacks the fixed suffix.",
              },
            ];
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify(findings) },
          },
        },
      });
    }
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
}
