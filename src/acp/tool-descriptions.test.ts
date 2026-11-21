import { expect, test } from "bun:test";
import { join } from "node:path";

type Schema = { description?: string; properties?: Record<string, Schema>; items?: Schema };
type Tool = { name: string; description: string; inputSchema: Schema };

const expected = {
  ask_team: {
    description:
      "Ask for a product or scope decision you cannot resolve from the issue, code, or available tools. Include enough context to answer without reading this session. Posting ends your turn; the answer arrives as your next message.",
    question:
      "The decision needed, relevant facts, and your recommendation with its main tradeoff. Make the question understandable on its own.",
    options:
      "Optional answer buttons: at most 3 labels, each at most 24 characters. Explain what each choice means in the question.",
    context:
      "Optional supporting details or links. Keep facts needed to understand the decision in question.",
  },
  update_plan: {
    description:
      "Replace this session's working checklist. Include every step you want to retain, with its current status; omitted steps disappear.",
    steps: "The complete updated checklist, in execution order.",
    "steps[].content": "A concrete action or outcome whose completion can be checked.",
    "steps[].status": "The step's current status.",
  },
  post_update: {
    description:
      "Post progress to the Linear session when a plan step completes or changes, you find something consequential, or you are blocked. Use reply for answers to a person. At most one update per minute; an early call posts nothing and returns the next allowed time.",
    text: "At most 500 characters: what changed or what is blocked, why it matters, and the next step.",
  },
  reply: {
    description:
      "Answer a person where they wrote in the Linear conversation. Use post_update for progress. At most 5 replies per turn; combine related points into one reply.",
    text: "The answer in Markdown, including the context needed to understand it.",
  },
  get_closeout: {
    description:
      "Refresh Closeout after edits and before finishing; edits can invalidate passed checks. Run command checks one at a time in pending order. A failed command blocks other commands; detail identifies what to fix. blocked lists exhausted retries; null remaining_attempts means unlimited retries. While running is nonempty, poll this tool for completion. Results include check hints, matched paths, statuses, failed attempts remaining, running start times, and different_model requirements. Reviews are listed separately, never in pending. This tool does not execute checks. After all command checks pass, it executes each listed rule's probe once per change; a nonzero rules exitCode reports a rule violation without changing pending or blocked.",
  },
  run_closeout: {
    description:
      "Execute one pending command check with its matching setup steps. Call get_closeout first and run the first pending id; run checks one at a time, not as a batch. While a check is failing, a request for another check answers `not run: fix <id> first` without running anything: fix the failure, then run the failed check again. Each failed execution uses one of that check's attempts. Waits up to 240 seconds, then returns running with check and started_at while execution continues; poll get_closeout until it finishes. Duplicate calls during execution return the running status. Refresh get_closeout after edits. Reviews run independently and cannot be started here.",
    id: "The first pending command-check id from the latest get_closeout result.",
    model: "Unused. Omit it; command checks do not select a model, and reviews run independently.",
  },
};

function described(tool: Tool): Record<string, string> {
  const texts: Record<string, string> = { description: tool.description };
  const walk = (properties: Record<string, Schema> | undefined, prefix: string) => {
    for (const [key, schema] of Object.entries(properties ?? {})) {
      if (schema.description !== undefined) texts[prefix + key] = schema.description;
      walk(schema.items?.properties, `${prefix}${key}[].`);
    }
  };
  walk(tool.inputSchema.properties, "");
  return texts;
}

test("the built-in tools list their descriptions and parameter descriptions", async () => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "ask-team-mcp.ts")], {
    env: {
      ...process.env,
      PAWS_ASK_TEAM_SOCKET: "/nonexistent.sock",
      PAWS_HOST_TOOLS: Object.keys(expected).join(","),
    },
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    void child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await child.stdin.flush();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const tools = (JSON.parse(text) as { result: { tools: Tool[] } }).result.tools;
    expect(Object.fromEntries(tools.map((tool) => [tool.name, described(tool)]))).toEqual(expected);
  } finally {
    child.kill();
  }
});
