import { connect } from "node:net";

/**
 * Stdio MCP server exposing `ask_team`. The agent spawns this process from
 * `session/new`. Calls are forwarded to the parent over `PAWS_ASK_TEAM_SOCKET`.
 * QM-07 supplies the parent hook (Linear elicitation); this process is the tool surface.
 */

const TOOL = {
  name: "ask_team",
  description:
    "Ask the engineering team a question and wait for their answer. Use this when a product or scope decision is needed.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Question for the team." },
      options: {
        type: "array",
        items: {
          anyOf: [
            { type: "string", minLength: 1 },
            {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1 },
                value: { type: "string", minLength: 1 },
              },
              required: ["value"],
              additionalProperties: false,
            },
          ],
        },
        description: "Optional strings or choices with a display label and a stable value.",
      },
      context: { type: "string", description: "Extra context the team should see." },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

const PLAN_TOOL = {
  name: "update_plan",
  description:
    "Replace the working checklist for this session. Send every step and its current status.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1, maxLength: 200 },
            status: {
              type: "string",
              enum: ["pending", "inProgress", "completed", "canceled"],
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
    },
    required: ["title", "body"],
    additionalProperties: false,
  },
};

const POST_UPDATE_TOOL = {
  name: "post_update",
  description:
    "Post a short progress update to the Linear session. At most one update per minute; a call within the window posts nothing and says when the next one is allowed.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 500, description: "The update." },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

const GET_CLOSEOUT_TOOL = {
  name: "get_closeout",
  description:
    "Refresh workspace changes and return the required closeout checks with hints, matched paths, statuses, remaining failed attempts and different_model requirements. pending lists the ids to run in order with run_closeout. blocked explains exhausted retries. Call after edits and before finishing. Later edits can invalidate passed checks. This tool does not run checks. A null remaining_attempts means unlimited retries. Reviews are listed and are not pending.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const RUN_CLOSEOUT_TOOL = {
  name: "run_closeout",
  description:
    "Run a pending closeout check by id, including matching setup steps, and return its result. Review checks are not run by this tool. Call get_closeout again after edits because passed checks can go stale.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Closeout check id from get_closeout." },
      model: {
        type: "string",
        description: "Unused for command checks. Reviews run in an independent session.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

const enabledTools = new Set((process.env.PAWS_HOST_TOOLS ?? "ask_team").split(","));

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
          TOOL,
          PLAN_TOOL,
          ARTIFACT_TOOL,
          PULL_REQUEST_TOOL,
          POST_UPDATE_TOOL,
          GET_CLOSEOUT_TOOL,
          RUN_CLOSEOUT_TOOL,
        ].filter((tool) => enabledTools.has(tool.name)),
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

async function drain(
  socketPath: string,
  incoming: Uint8Array<ArrayBufferLike>,
): Promise<Uint8Array<ArrayBufferLike>> {
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
      await handle(socketPath, JSON.parse(body) as Rpc);
      continue;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return buffer;
    const line = decoder.decode(buffer.subarray(0, newline)).replace(/\r$/, "");
    buffer = buffer.subarray(newline + 1);
    if (!line.trim()) continue;
    framing = "ndjson";
    await handle(socketPath, JSON.parse(line) as Rpc);
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
    buffer = await drain(socketPath, buffer);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("ask-team-mcp.ts") || entry.endsWith("ask-team-mcp.js")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
