import { describe, expect, test } from "bun:test";
import { openPullRequest } from "../src/github";
import type { GitHubClient } from "../src/github";

describe("pull request closing line", () => {
  test("a Linear issue still starts with Fixes", async () => {
    const seen = await opened({
      issue: "ENG-123",
      owner: "pmdroid",
      repo: "paws-demo",
      evidence: "Closeout accepted",
    });
    expect(seen.head).toBe("paws/ENG-123");
    expect(seen.body.split("\n")[0]).toBe("Fixes ENG-123");
    expect(seen.body).toContain("Closeout accepted");
  });

  test("a GitHub issue in the same repo closes with Closes #n", async () => {
    const seen = await opened({
      issue: "github:pmdroid/paws-demo#15",
      owner: "pmdroid",
      repo: "paws-demo",
      evidence: "Closeout accepted",
    });
    expect(seen.head).toBe("paws/gh-pmdroid-paws-demo-15");
    expect(seen.body.split("\n")[0]).toBe("Closes #15");
    expect(seen.body).toContain("Closeout accepted");
    expect(seen.body).not.toContain("Fixes ");
  });

  test("a GitHub issue in another repo closes with owner/repo#n", async () => {
    const seen = await opened({
      issue: "github:other/lib#3",
      owner: "pmdroid",
      repo: "paws-demo",
      evidence: "",
    });
    expect(seen.head).toBe("paws/gh-other-lib-3");
    expect(seen.body).toBe("Closes other/lib#3\n");
  });
});

async function opened(input: {
  issue: string;
  owner: string;
  repo: string;
  evidence: string;
}): Promise<{ head: string; body: string }> {
  const calls: unknown[] = [];
  const client: GitHubClient = {
    async request(req) {
      calls.push(req.body);
      const body =
        isRecord(req.body) && typeof req.body["body"] === "string" ? req.body["body"] : "";
      return {
        status: 201,
        body: {
          number: 4,
          html_url: `https://github.com/${input.owner}/${input.repo}/pull/4`,
          body,
        },
      };
    },
  };
  await openPullRequest({
    issue: input.issue,
    owner: input.owner,
    repo: input.repo,
    evidence: input.evidence,
    client,
    tokenProvider: {
      mode: "app",
      tokenFor: async () => "ghs_test",
    },
  });
  const payload = calls[0];
  if (
    !isRecord(payload) ||
    typeof payload["head"] !== "string" ||
    typeof payload["body"] !== "string"
  ) {
    throw new Error("pull request body was not recorded");
  }
  return { head: payload["head"], body: payload["body"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
