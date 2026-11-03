import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { startAskTeamBridge } from "../src/acp";
import { readCiLog, type GitHubClient } from "../src/github";
import { remoteCiLog } from "../src/runner-worker";

const head = "b".repeat(40);
const token = "ghs_syntheticInstallationToken";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const client: GitHubClient = {
  async request(request) {
    if (request.token !== token) throw new Error("missing token");
    if (request.path === "/repos/owner/repo/pulls/7")
      return { status: 200, body: { state: "open", head: { sha: head } } };
    if (request.path.startsWith(`/repos/owner/repo/commits/${head}/check-runs`))
      return {
        status: 200,
        body: {
          check_runs: [
            {
              id: 11,
              name: "test",
              conclusion: "failure",
              html_url: `https://x-access-token:${token}@github.com/owner/repo/actions/runs/1/job/11`,
              app: { slug: "github-actions" },
            },
          ],
        },
      };
    if (request.path === "/repos/owner/repo/actions/jobs/11/logs")
      return { status: 200, body: `Authorization: Bearer ***\n##[error]boom` };
    throw new Error(`unexpected request ${request.path}`);
  },
};

async function bridge() {
  const root = mkdtempSync(join(tmpdir(), "paws-ci-log-"));
  roots.push(root);
  const socketPath = join(root, "ask-team.sock");
  const emitted: unknown[] = [];
  const answers = new Map<string, Promise<string>>();
  const ciLog = remoteCiLog(
    (event) => {
      emitted.push(event);
      answers.set(
        event.requestId,
        readCiLog({
          client,
          owner: "owner",
          repo: "repo",
          prNumber: 7,
          job: event.job,
          tokenProvider: { mode: "token", tokenFor: async () => token },
        }).then(
          (answer) => JSON.stringify({ answer }),
          (error: Error) => JSON.stringify({ error: error.message }),
        ),
      );
    },
    async (requestId) => ({ answer: await answers.get(requestId)! }),
    new AbortController().signal,
  );
  const started = await startAskTeamBridge({
    socketPath,
    context: { itemId: "ENG-1", runId: "run", role: "implementer" },
    ciLog,
    signal: new AbortController().signal,
  });
  return { started, socketPath, emitted };
}

function call(socketPath: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () =>
      socket.write(`${JSON.stringify({ id: 1, tool: "get_ci_log", arguments: args })}\n`),
    );
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(data));
  });
}

test("get_ci_log is offered, answers through the runner channel and never carries the token", async () => {
  const { started, socketPath, emitted } = await bridge();
  try {
    const tools = started.mcpServer.env.find((item) => item.name === "PAWS_HOST_TOOLS")?.value;
    expect(tools?.split(",")).toContain("get_ci_log");
    const list = await call(socketPath, {});
    expect(JSON.parse(JSON.parse(list).answer)).toEqual({
      head,
      failed: [{ name: "test", conclusion: "failure", job: 11, url: null }],
    });
    const log = await call(socketPath, { job: "test" });
    expect(JSON.parse(log).answer).toEndWith("##[error]boom");
    const refused = await call(socketPath, { job: "12" });
    expect(JSON.parse(refused).error).toContain("is not one of the checks");
    for (const response of [list, log, refused]) {
      expect(response).not.toContain(token);
      expect(response).not.toContain("x-access-token");
    }
    expect(emitted).toEqual([
      { type: "ci_log", requestId: expect.any(String) },
      { type: "ci_log", requestId: expect.any(String), job: "test" },
      { type: "ci_log", requestId: expect.any(String), job: "12" },
    ]);
  } finally {
    await started.close();
  }
});

test("the 21st get_ci_log call in a turn is refused", async () => {
  const { started, socketPath, emitted } = await bridge();
  try {
    for (let index = 0; index < 20; index++)
      expect(JSON.parse(await call(socketPath, {})).answer).toBeString();
    expect(JSON.parse(await call(socketPath, {})).error).toBe("CI log limit reached for this turn");
    expect(emitted).toHaveLength(20);
  } finally {
    await started.close();
  }
});
