import { journalCaught } from "../journal";
import { connect } from "node:net";

/**
 * Stdio MCP server exposing `ask_team`. The agent spawns this process from
 * `session/new`. Calls are forwarded to the parent over `PAWS_ASK_TEAM_SOCKET`.
 * QM-07 supplies the parent hook (Linear elicitation); this process is the tool surface.
 */

const TOOL = {
  name: "ask_team",
  description:
    "Ask for a product or scope decision you cannot resolve from the issue, code, or available tools. Include enough context to answer without reading this session. Posting ends your turn; the answer arrives as your next message.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The decision needed, relevant facts, and your recommendation with its main tradeoff. Make the question understandable on its own.",
      },
      options: {
        type: "array",
        maxItems: 3,
        items: {
          anyOf: [
            { type: "string", minLength: 1, maxLength: 24 },
            {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1, maxLength: 24 },
                value: { type: "string", minLength: 1 },
              },
              required: ["value"],
              additionalProperties: false,
            },
          ],
        },
        description:
          "Optional answer buttons: at most 3 labels, each at most 24 characters. Explain what each choice means in the question.",
      },
      context: {
        type: "string",
        description:
          "Optional supporting details or links. Keep facts needed to understand the decision in question.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

const PLAN_TOOL = {
  name: "update_plan",
  description:
    "Replace this session's working checklist. Include every step you want to retain, with its current status; omitted steps disappear.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        description: "The complete updated checklist, in execution order.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "A concrete action or outcome whose completion can be checked.",
            },
            status: {
              type: "string",
              enum: ["pending", "inProgress", "completed", "canceled"],
              description: "The step's current status.",
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
};

const ARTIFACT_TOOL = {
  name: "publish_artifact",
  description: "Publish a file from the workspace and return a link to share with the user.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file to publish." },
      displayName: {
        type: "string",
        description:
          "Optional deliverable name shown to the user. Reuse this name when retrying with a corrected path.",
      },
      mimeType: { type: "string", description: "Optional MIME type, such as image/png." },
      attachToIssue: {
        type: "boolean",
        description:
          "Add a persistent file attachment card to the current Linear issue when requested by the user.",
      },
      checkId: {
        type: "string",
        description:
          "Closeout check id from get_closeout that a WebM or MP4 video or a PNG, JPEG or WebP screenshot proves. Paws keeps the file as evidence for that check, up to 200 MB for a video and 20 MB for a screenshot, and posts a Paws link to Linear instead of uploading the file.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const PULL_REQUEST_TOOL = {
  name: "open_pull_request",
  description:
    "Set the title and description of this task's pull request. Paws opens or updates the pull request with them after Closeout accepts the work. Call again to replace them.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 256, description: "One-line title." },
      body: {
        type: "string",
        minLength: 1,
        maxLength: 12000,
        description: "Markdown description: what changed, why, and how you verified it.",
      },
      remaining: {
        type: "array",
        description:
          "Work left for later pull requests. The item ends when this pull request merges; Paws then files each part as a sub-issue delegated to Paws. More than 3 parts: ask_team instead.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120, description: "One-line title." },
            scope: {
              type: "string",
              minLength: 1,
              maxLength: 4000,
              description: "The files and what is left in them.",
            },
          },
          required: ["title", "scope"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "body"],
    additionalProperties: false,
  },
};

const POST_UPDATE_TOOL = {
  name: "post_update",
  description:
    "Post progress to the Linear session when a plan step completes or changes, you find something consequential, or you are blocked. Use reply for answers to a person. At most one update per minute; an early call posts nothing and returns the next allowed time.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description:
          "At most 500 characters: what changed or what is blocked, why it matters, and the next step.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

const REPLY_TOOL = {
  name: "reply",
  description:
    "Answer a person where they wrote in the Linear conversation. Use post_update for progress. At most 5 replies per turn; combine related points into one reply.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description: "The answer in Markdown, including the context needed to understand it.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

const START_WORK_TOOL = {
  name: "start_work",
  description:
    "Move this conversation to a work turn. Call it only when the person asked for a change or agreed to one. Your turn ends at once; Paws queues the item for a work slot and the work turn resumes this session with edits allowed. The plan is posted to the person.",
  inputSchema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description: "What you will change and why.",
      },
    },
    required: ["plan"],
    additionalProperties: false,
  },
};

const GET_CLOSEOUT_TOOL = {
  name: "get_closeout",
  description:
    "Refresh Closeout after edits and before finishing; edits can invalidate passed checks. Run command checks one at a time in pending order. A failed command blocks other commands; detail identifies what to fix. blocked lists exhausted retries; null remaining_attempts means unlimited retries. While running is nonempty, poll this tool for completion. Results include check hints, matched paths, statuses, failed attempts remaining, running start times, and different_model requirements. Reviews are listed separately, never in pending. This tool does not execute checks. After all command checks pass, it executes each listed rule's probe once per change; a nonzero rules exitCode reports a rule violation without changing pending or blocked.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const RUN_CLOSEOUT_TOOL = {
  name: "run_closeout",
  description:
    "Execute one pending command check with its matching setup steps. Call get_closeout first and run the first pending id; run checks one at a time, not as a batch. While a check is failing, a request for another check answers `not run: fix <id> first` without running anything: fix the failure, then run the failed check again. Each failed execution uses one of that check's attempts. Waits up to 240 seconds, then returns running with check and started_at while execution continues; poll get_closeout until it finishes. Duplicate calls during execution return the running status. Refresh get_closeout after edits. Reviews run independently and cannot be started here.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The first pending command-check id from the latest get_closeout result.",
      },
      model: {
        type: "string",
        description:
          "Unused. Omit it; command checks do not select a model, and reviews run independently.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

const RERUN_CI_TOOL = {
  name: "rerun_ci",
  description:
    "Re-run the failed GitHub Actions jobs on this pull request's current head commit, once per commit, after every check finished. Give the evidence that the failure is outside your change and flaky. Paws records the reason on the item.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "Why the failed job is outside your change and looks flaky.",
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

const REMEMBER_TOOL = {
  name: "remember",
  description:
    "Save a durable fact about this Linear project for future Paws sessions. Saved entries are shown to later agents working on the same project as background, so keep each entry short and high-signal. Save only what would change how a future agent works on this project: a convention, a constraint, a pitfall, or an open question nobody has answered. Skip anything that's in the code, the issue or the docs; task progress; and what you changed (that goes in the pull request). You cannot save decisions; Paws records those when a person answers ask_team.",
  inputSchema: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "patch", "remove"] },
            kind: { type: "string", enum: ["fact", "open_question"] },
            content: {
              type: "string",
              minLength: 1,
              maxLength: 400,
              description: "The entry text. Required for add and patch.",
            },
            old_text: {
              type: "string",
              minLength: 1,
              description:
                "The exact text of one entry this task saved. Required for patch and remove.",
            },
          },
          required: ["action", "kind"],
          additionalProperties: false,
        },
        description: "At most 5 operations, applied together or not at all.",
      },
    },
    required: ["operations"],
    additionalProperties: false,
  },
};

const RECALL_TOOL = {
  name: "recall",
  description:
    "Look up this Linear project's saved memory: facts, open questions and decisions that earlier Paws sessions, people's answers and the project's Linear documents left. Pass query to search, or id to read one entry from the memory index in your brief. Use it when the index mentions something relevant to your task; don't call it for things the issue already says.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Words to search the project's memory for. Pass this or id, not both.",
      },
      id: {
        type: "string",
        minLength: 1,
        description: "The id of one entry from the memory index. Pass this or query, not both.",
      },
    },
    additionalProperties: false,
  },
};

const ADD_REPOSITORY_TOOL = {
  name: "add_repository",
  description:
    "Add a GitHub repository to your working folder, read-only, at repositories/<owner>/<name>. Use it when you need to read files Paws did not give you. At most 5 repositories per run.",
  inputSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        minLength: 3,
        maxLength: 140,
        description: "The repository as owner/name.",
      },
    },
    required: ["repository"],
    additionalProperties: false,
  },
};

const enabledTools = new Set((process.env.PAWS_HOST_TOOLS ?? "ask_team").split(","));

const BUILT_IN_TOOLS = [
  TOOL,
  PLAN_TOOL,
  ARTIFACT_TOOL,
  PULL_REQUEST_TOOL,
  POST_UPDATE_TOOL,
  REPLY_TOOL,
  START_WORK_TOOL,
  GET_CLOSEOUT_TOOL,
  RUN_CLOSEOUT_TOOL,
  RERUN_CI_TOOL,
  REMEMBER_TOOL,
  RECALL_TOOL,
  ADD_REPOSITORY_TOOL,
];

function definedTools(): { name: string; description: string; inputSchema: unknown }[] {
  const raw = process.env.PAWS_HOST_TOOL_DEFINITIONS;
  if (!raw) return [];
  const builtIn = new Set(BUILT_IN_TOOLS.map((tool) => tool.name));
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (tool): tool is { name: string; description: string; inputSchema: unknown } =>
      typeof tool?.name === "string" && !builtIn.has(tool.name) && enabledTools.has(tool.name),
  );
}

type Rpc = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

let framing: "ndjson" | "lsp" = "ndjson";

function send(message: unknown): void {
  const body = JSON.stringify(message);
  if (framing === "lsp") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function respond(id: number | string | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function askParent(
  socketPath: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const payload = JSON.stringify({
    id: Date.now(),
    tool,
    arguments: args,
  });
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("host tool connection closed")));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as { answer?: string; error?: string };
        if (message.error) reject(new Error(message.error));
        else resolve(message.answer ?? "");
      } catch (error) {
        journalCaught(error, "ask-team-mcp.askParent.parse", null);
        reject(error);
      }
    });
    socket.write(`${payload}\n`);
  });
}

async function handle(socketPath: string, message: Rpc): Promise<void> {
  if (!message.method || message.id == null) return;
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "paws-host-tools", version: "0.0.0" },
      });
      return;
    case "ping":
      respond(message.id, {});
      return;
    case "tools/list":
      respond(message.id, {
        tools: [
          ...BUILT_IN_TOOLS.filter((tool) => enabledTools.has(tool.name)),
          ...definedTools().map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        ],
      });
      return;
    case "prompts/list":
      respond(message.id, { prompts: [] });
      return;
    case "resources/list":
      respond(message.id, { resources: [] });
      return;
    case "tools/call": {
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string" || !enabledTools.has(name)) {
        respond(message.id, {
          content: [{ type: "text", text: `unknown tool ${String(name)}` }],
          isError: true,
        });
        return;
      }
      try {
        const answer = await askParent(socketPath, name, args);
        respond(message.id, { content: [{ type: "text", text: answer }], isError: false });
      } catch (error) {
        journalCaught(error, "ask-team-mcp.handle.askParent", null);
        const text = error instanceof Error ? error.message : String(error);
        respond(message.id, { content: [{ type: "text", text }], isError: true });
      }
      return;
    }
    default:
      fail(message.id, -32601, `method not found: ${message.method}`);
  }
}

const decoder = new TextDecoder();

function findBytes(buffer: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || buffer.length < needle.length) return -1;
  for (let index = 0; index <= buffer.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (buffer[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function dispatch(socketPath: string, message: Rpc): void {
  handle(socketPath, message).catch((error: unknown) => {
    journalCaught(error, "ask-team-mcp.dispatch", null);
    const text = error instanceof Error ? error.message : String(error);
    if (message.id != null) fail(message.id, -32603, text);
  });
}

function drain(
  socketPath: string,
  incoming: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  let buffer: Uint8Array<ArrayBufferLike> = incoming;
  const headerBreak = new Uint8Array([13, 10, 13, 10]);
  for (;;) {
    if (buffer.length === 0) return buffer;
    const prefix = decoder.decode(buffer.subarray(0, 16));
    if (prefix.startsWith("Content-Length")) {
      framing = "lsp";
      const headerEnd = findBytes(buffer, headerBreak);
      if (headerEnd < 0) return buffer;
      const header = decoder.decode(buffer.subarray(0, headerEnd));
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      const lengthText = match?.[1];
      if (!lengthText) return buffer.subarray(headerEnd + 4);
      const length = Number(lengthText);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return buffer;
      const body = decoder.decode(buffer.subarray(start, start + length));
      buffer = buffer.subarray(start + length);
      dispatch(socketPath, JSON.parse(body) as Rpc);
      continue;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return buffer;
    const line = decoder.decode(buffer.subarray(0, newline)).replace(/\r$/, "");
    buffer = buffer.subarray(newline + 1);
    if (!line.trim()) continue;
    framing = "ndjson";
    dispatch(socketPath, JSON.parse(line) as Rpc);
  }
}

async function main(): Promise<void> {
  const socketPath = process.env.PAWS_ASK_TEAM_SOCKET;
  if (!socketPath) {
    process.stderr.write("PAWS_ASK_TEAM_SOCKET is required\n");
    process.exit(1);
  }
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for await (const chunk of process.stdin) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    buffer = concatBytes(buffer, bytes);
    buffer = drain(socketPath, buffer);
  }
}

const entry = process.argv[1] ?? "";
if (
  process.argv[2] === "__ask-team-mcp" ||
  entry.endsWith("ask-team-mcp.ts") ||
  entry.endsWith("ask-team-mcp.js")
) {
  main().catch((error: unknown) => {
    journalCaught(error, "ask-team-mcp.recover.main", null);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
