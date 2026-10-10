import { describe, expect, test } from "bun:test";
import {
  GitHubEpicCycleError,
  createGitHubIssuesClient,
  githubTrackerConfig,
  loadGitHubEpic,
  parseTaskList,
  startFakeGitHubRest,
  type FakeGitHubRest,
  type FakeIssue,
  type GitHubIssuesClient,
} from "../src/ghissues";

const NOW = 1_700_000_000_000;

describe("github epic intake", () => {
  test("three sub-issues keep API order ahead of a task list", async () => {
    const fake = startFakeGitHubRest();
    const client = clientFor(fake);
    try {
      fake.addIssue("acme", "widgets", issue(1, "Epic", { body: "- [ ] #99\n" }));
      fake.addIssue("acme", "widgets", issue(2, "Two"));
      fake.addIssue("acme", "widgets", issue(4, "Four"));
      fake.addIssue("acme", "widgets", issue(3, "Three"));
      fake.setSubIssues("acme", "widgets", 1, [
        issue(2, "Two"),
        issue(4, "Four"),
        issue(3, "Three"),
      ]);
      const snapshot = await loadGitHubEpic(client, { owner: "acme", repo: "widgets", number: 1 });
      expect(snapshot.linearIssueId).toBe("github:acme/widgets#1");
      expect(snapshot.identifier).toBe("widgets#1");
      expect(snapshot.title).toBe("Epic");
      expect(snapshot.subIssues.map((item) => item.identifier)).toEqual([
        "widgets#2",
        "widgets#4",
        "widgets#3",
      ]);
      expect(snapshot.subIssues.map((item) => item.linearIssueId)).toEqual([
        "github:acme/widgets#2",
        "github:acme/widgets#4",
        "github:acme/widgets#3",
      ]);
      expect(snapshot.subIssues.map((item) => item.title)).toEqual(["Two", "Four", "Three"]);
      expect(fake.requests.some((request) => request.path.endsWith("/issues/99"))).toBe(false);
      expect(fake.commentsPosted).toEqual([]);
    } finally {
      await fake.stop();
    }
  });

  test("a task list skips checked rows and keeps body order", async () => {
    const body = [
      "- [ ] #4 Later",
      "- [x] #3 Done",
      "- [X] #8 Also done",
      "- [ ] #2 First",
      "- [ ] other/lib#5 Cross",
    ].join("\n");
    expect(
      parseTaskList(body, { owner: "acme", repo: "widgets" }).map((task) => task.number),
    ).toEqual([4, 2, 5]);
    const fake = startFakeGitHubRest();
    const client = clientFor(fake);
    try {
      fake.addIssue("acme", "widgets", issue(1, "Checklist", { body }));
      fake.addIssue("acme", "widgets", issue(4, "Fourth"));
      fake.addIssue("acme", "widgets", issue(3, "Done"));
      fake.addIssue("acme", "widgets", issue(8, "Skipped"));
      fake.addIssue("acme", "widgets", issue(2, "First"));
      fake.addIssue("other", "lib", issue(5, "Cross", { owner: "other", repo: "lib" }));
      const snapshot = await loadGitHubEpic(client, { owner: "acme", repo: "widgets", number: 1 });
      expect(snapshot.subIssues.map((item) => item.identifier)).toEqual([
        "widgets#4",
        "widgets#2",
        "lib#5",
      ]);
      expect(snapshot.subIssues.map((item) => item.title)).toEqual(["Fourth", "First", "Cross"]);
      expect(snapshot.subIssues.map((item) => item.linearIssueId)).toEqual([
        "github:acme/widgets#4",
        "github:acme/widgets#2",
        "github:other/lib#5",
      ]);
      expect(fake.requests.some((request) => request.path.endsWith("/issues/3"))).toBe(false);
      expect(fake.commentsPosted).toEqual([]);
    } finally {
      await fake.stop();
    }
  });

  test("blocked-by edges reorder the sub-issues", async () => {
    const fake = startFakeGitHubRest();
    const client = clientFor(fake);
    try {
      fake.addIssue("acme", "widgets", issue(1, "Epic"));
      const two = issue(2, "Two");
      const three = issue(3, "Three");
      const four = issue(4, "Four");
      fake.setSubIssues("acme", "widgets", 1, [two, three, four]);
      fake.setBlockedBy("acme", "widgets", 2, [three]);
      fake.setBlockedBy("acme", "widgets", 3, [four]);
      const snapshot = await loadGitHubEpic(client, { owner: "acme", repo: "widgets", number: 1 });
      expect(snapshot.subIssues.map((item) => item.identifier)).toEqual([
        "widgets#4",
        "widgets#3",
        "widgets#2",
      ]);
      expect(fake.commentsPosted).toEqual([]);
    } finally {
      await fake.stop();
    }
  });

  test("a blocked-by cycle posts one comment and runs nothing", async () => {
    const fake = startFakeGitHubRest();
    const client = clientFor(fake);
    try {
      fake.addIssue("acme", "widgets", issue(1, "Epic"));
      fake.setSubIssues("acme", "widgets", 1, [issue(2, "Two"), issue(3, "Three")]);
      fake.setBlockedBy("acme", "widgets", 2, [issue(3, "Three")]);
      fake.setBlockedBy("acme", "widgets", 3, [issue(2, "Two")]);
      const error = await loadGitHubEpic(client, {
        owner: "acme",
        repo: "widgets",
        number: 1,
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(GitHubEpicCycleError);
      if (!(error instanceof GitHubEpicCycleError)) return;
      expect(error.identifiers).toEqual(["widgets#2", "widgets#3"]);
      expect(fake.commentsPosted).toEqual([
        {
          owner: "acme",
          repo: "widgets",
          number: 1,
          body: error.message,
        },
      ]);
      expect(error.message).toContain("widgets#2");
      expect(error.message).toContain("widgets#3");
      expect(error.message).toContain("Nothing will run");
      expect(fake.commentsPosted).toHaveLength(1);
    } finally {
      await fake.stop();
    }
  });

  test("an issue with no children is the epic alone", async () => {
    const fake = startFakeGitHubRest();
    const client = clientFor(fake);
    try {
      fake.addIssue("acme", "widgets", issue(1, "Solo", { body: "Just this." }));
      const snapshot = await loadGitHubEpic(client, { owner: "acme", repo: "widgets", number: 1 });
      expect(snapshot.subIssues).toEqual([]);
      expect(snapshot.linearIssueId).toBe("github:acme/widgets#1");
      expect(snapshot.identifier).toBe("widgets#1");
      expect(fake.commentsPosted).toEqual([]);
    } finally {
      await fake.stop();
    }
  });
});

function clientFor(fake: FakeGitHubRest): GitHubIssuesClient {
  return createGitHubIssuesClient({
    provider: {
      source: "app",
      async token() {
        return "ghs_test";
      },
      async user() {
        return { login: "octocat", id: 1 };
      },
    },
    config: githubTrackerConfig({ repos: ["acme/widgets"] }),
    baseUrl: fake.origin,
  });
}

function issue(number: number, title: string, extra: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number,
    title,
    authorAssociation: "OWNER",
    updatedAt: new Date(NOW).toISOString(),
    ...extra,
  };
}
