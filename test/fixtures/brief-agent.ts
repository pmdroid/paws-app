import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const purpose = process.env.BRIEF_PURPOSE;
const evidence = process.env.BRIEF_EVIDENCE;
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: { cwd?: string; prompt?: Array<{ type: string; text?: string }> };
  };
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
  } else if (message.method === "session/new") {
    if (message.params?.cwd) process.chdir(message.params.cwd);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `brief-${purpose}` } });
  } else if (message.method === "session/prompt") {
    const prompt = message.params?.prompt?.map((block) => block.text ?? "").join("\n") ?? "";
    if (evidence) appendFileSync(evidence, `${JSON.stringify({ purpose, prompt })}\n`);
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
          sessionId: `brief-${purpose}`,
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
