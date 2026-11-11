import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ignoredCommentBots,
  ignoredCommentMarkers,
  loadConfigFile,
  parseConfigToml,
  readMergeSettings,
  storedMerge,
  writeMergePolicy,
} from "../src/config";
import {
  beginImplementRun,
  bindWorkItemRepository,
  enterMergeQueue,
  insertQueuedItem,
  migrate,
  openDatabase,
  pendingPullComments,
  recordItemPullRequest,
  sqliteDb,
} from "../src/db";
import { acceptGitHubDelivery, type PullCommentFilter } from "../src/loop";
import { handleMergeSettingsRequest, type MergeSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";

const MARKERS = ["<!-- add-pr-comment:todo-count -->", "<!-- deploy-security-proof -->"];
const POLICY = { default: { order: "queue", mainMoved: "ci" }, projects: [], rules: [] } as const;

function fixture() {
  const configPath = join(tempHome(), "config.toml");
  const audits: string[] = [];
  const options: MergeSettingsOptions = {
    configPath,
    csrfToken: "test-token",
    audit: async (_action, subject) => {
      audits.push(subject);
    },
  };
  return { options, audits };
}

function request(method = "GET", body?: unknown) {
  return new Request("http://127.0.0.1:8787/api/settings/merging", {
    method,
    headers: { "Content-Type": "application/json", "x-paws-csrf": "test-token" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("ignore_comment_markers in config.toml", () => {
  test("parse, write back and parse again give the same lists", () => {
    const home = tempHome();
    const path = join(home, "config.toml");
    const text = `[merge.repositories."acme/monorepo"]\npackages = []\nignore_comment_bots = ["codecov[bot]"]\nignore_comment_markers = [${MARKERS.map((marker) => JSON.stringify(marker)).join(", ")}]\n`;
    writeFileSync(path, text);
    const first = loadConfigFile(path);
    const settings = readMergeSettings(first);
    expect(settings.repositories["acme/monorepo"]).toEqual({
      packages: [],
      ignoreCommentBots: ["codecov[bot]"],
      ignoreCommentMarkers: MARKERS,
    });
    expect(ignoredCommentMarkers(settings, "ACME/monorepo")).toEqual(MARKERS);
    expect(ignoredCommentMarkers(settings, "acme/web")).toEqual([]);

    writeMergePolicy(
      path,
      { default: settings.default, projects: {}, rules: [] },
      storedMerge(first),
    );
    expect(readFileSync(path, "utf8")).toContain(
      `ignore_comment_markers = ["<!-- add-pr-comment:todo-count -->", "<!-- deploy-security-proof -->"]`,
    );
    expect(readMergeSettings(loadConfigFile(path)).repositories).toEqual(settings.repositories);
  });

  test("an empty marker, too many markers or a repeated one is rejected with a clear message", () => {
    const table = (markers: string[]) =>
      `[merge.repositories."acme/monorepo"]\nignore_comment_markers = [${markers.map((marker) => JSON.stringify(marker)).join(", ")}]\n`;
    expect(() => parseConfigToml(table([""]))).toThrow(
      "config.toml merge.repositories.acme/monorepo.ignore_comment_markers.0 must not be empty",
    );
    expect(() => parseConfigToml(table(["  "]))).toThrow("must not be empty");
    expect(() =>
      parseConfigToml(table(Array.from({ length: 101 }, (_, index) => `<!-- m-${index} -->`))),
    ).toThrow("lists more than 100 markers");
    expect(() => parseConfigToml(table(["<!-- a -->", "<!-- a -->"]))).toThrow(
      "lists a marker twice",
    );
    expect(() => parseConfigToml(table(["x".repeat(201)]))).toThrow("at most 200 characters");
  });
});

describe("Settings › Merging › Ignored PR comments", () => {
  test("GET returns both lists per repository and PUT saves changes to them", async () => {
    const { options, audits } = fixture();
    writeFileSync(
      options.configPath,
      '[merge.repositories."acme/monorepo"]\npackages = ["apps/*"]\nignore_comment_bots = ["codecov[bot]"]\n',
    );
    const listed = { ...options, repos: ["acme/web"] };
    const view = (await (await handleMergeSettingsRequest(request(), listed))!.json()) as {
      ignoredComments: unknown;
    };
    expect(view.ignoredComments).toEqual([
      {
        repository: "acme/monorepo",
        ignoreCommentBots: ["codecov[bot]"],
        ignoreCommentMarkers: [],
      },
      {
        repository: "acme/web",
        ignoreCommentBots: expect.arrayContaining(["linear[bot]", "codecov[bot]"]),
        ignoreCommentMarkers: [],
      },
    ]);

    const saved = await handleMergeSettingsRequest(
      request("PUT", {
        ...POLICY,
        ignoredComments: [
          {
            repository: "acme/monorepo",
            ignoreCommentBots: ["codecov[bot]", " deploy-bot "],
            ignoreCommentMarkers: MARKERS,
          },
          {
            repository: "acme/web",
            ignoreCommentBots: ["linear[bot]"],
            ignoreCommentMarkers: [],
          },
        ],
      }),
      listed,
    );
    expect(saved?.status).toBe(200);
    expect(((await saved!.json()) as { ignoredComments: unknown }).ignoredComments).toEqual([
      {
        repository: "acme/monorepo",
        ignoreCommentBots: ["codecov[bot]", "deploy-bot"],
        ignoreCommentMarkers: MARKERS,
      },
      { repository: "acme/web", ignoreCommentBots: ["linear[bot]"], ignoreCommentMarkers: [] },
    ]);
    expect(readMergeSettings(loadConfigFile(options.configPath)).repositories).toEqual({
      "acme/monorepo": {
        packages: ["apps/*"],
        ignoreCommentBots: ["codecov[bot]", "deploy-bot"],
        ignoreCommentMarkers: MARKERS,
      },
      "acme/web": { packages: [], ignoreCommentBots: ["linear[bot]"] },
    });
    expect(audits).toEqual([
      "Ignored comment bots for acme/monorepo: codecov[bot] → codecov[bot], deploy-bot",
      `Ignored comment markers for acme/monorepo: none → ${MARKERS.join(", ")}`,
      expect.stringMatching(
        /^Ignored comment bots for acme\/web: .*linear\[bot\].* → linear\[bot\]$/,
      ),
    ]);

    expect((await handleMergeSettingsRequest(request("PUT", POLICY), listed))?.status).toBe(200);
    expect(
      ignoredCommentMarkers(readMergeSettings(loadConfigFile(options.configPath)), "acme/monorepo"),
    ).toEqual(MARKERS);
  });

  test("an invalid value is rejected with a field error and the file stays unchanged", async () => {
    const { options } = fixture();
    const text = '[merge.repositories."acme/monorepo"]\npackages = []\n';
    writeFileSync(options.configPath, text);
    const entry = { repository: "acme/monorepo", ignoreCommentBots: [], ignoreCommentMarkers: [] };
    for (const [lists, field, message] of [
      [{ ...entry, ignoreCommentMarkers: [""] }, "ignoreCommentMarkers", "must not be empty"],
      [
        {
          ...entry,
          ignoreCommentMarkers: Array.from({ length: 101 }, (_, index) => `<!-- m-${index} -->`),
        },
        "ignoreCommentMarkers",
        "lists more than 100 markers",
      ],
      [{ ...entry, ignoreCommentBots: ["a b"] }, "ignoreCommentBots", "must be a GitHub login"],
    ] as const) {
      const response = await handleMergeSettingsRequest(
        request("PUT", { ...POLICY, ignoredComments: [lists] }),
        options,
      );
      expect(response?.status).toBe(400);
      const body = (await response!.json()) as { error: string; field: string };
      expect(body.field).toBe(`ignoredComments.0.${field}`);
      expect(body.error).toContain(message);
      expect(readFileSync(options.configPath, "utf8")).toBe(text);
    }
  });

  test("after a save the next comment delivery uses the new lists without a restart", async () => {
    const { options } = fixture();
    const db = openDatabase(":memory:");
    migrate(db);
    await insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
    await bindWorkItemRepository(sqliteDb(db), "eng-1", {
      owner: "acme",
      repo: "monorepo",
      remoteUrl: "https://github.com/acme/monorepo.git",
    });
    await beginImplementRun(sqliteDb(db), "eng-1", 1);
    await enterMergeQueue(sqliteDb(db), "eng-1", {
      phase: "merge_queue",
      baseSha: "b",
      wipCommit: "h",
    });
    await recordItemPullRequest(sqliteDb(db), {
      itemId: "eng-1",
      pullNumber: 7,
      pullUrl: null,
      openedAt: 1,
    });
    const settings = () => readMergeSettings(loadConfigFile(options.configPath));
    const filter: PullCommentFilter = {
      appId: async () => null,
      appLogin: () => null,
      ignoredBots: (repository) => ignoredCommentBots(settings(), repository),
      ignoredMarkers: (repository) => ignoredCommentMarkers(settings(), repository),
    };
    let delivery = 0;
    const comment = (id: number, author: string, body: string) =>
      acceptGitHubDelivery(
        sqliteDb(db),
        {
          deliveryId: `d-${(delivery += 1)}`,
          event: "issue_comment",
          payload: JSON.stringify({
            action: "created",
            repository: { id: 11, name: "monorepo", owner: { login: "acme" } },
            issue: { number: 7, pull_request: {} },
            comment: { id, body, user: { login: author } },
          }),
        },
        1_000,
        filter,
      );
    const recorded = async () =>
      (await pendingPullComments(sqliteDb(db), "eng-1")).map((row) => row.commentId);
    try {
      await comment(1, "github-actions[bot]", "<!-- deploy-security-proof -->\nResult: **PASS**");
      expect(await recorded()).toEqual([1]);

      const saved = await handleMergeSettingsRequest(
        request("PUT", {
          ...POLICY,
          ignoredComments: [
            {
              repository: "acme/monorepo",
              ignoreCommentBots: ["deploy-bot"],
              ignoreCommentMarkers: ["<!-- deploy-security-proof -->"],
            },
          ],
        }),
        options,
      );
      expect(saved?.status).toBe(200);
      await comment(2, "github-actions[bot]", "<!-- deploy-security-proof -->\nResult: **PASS**");
      await comment(3, "deploy-bot", "Deployed to staging.");
      await comment(4, "github-actions[bot]", "Result: **FAIL**");
      expect(await recorded()).toEqual([1, 4]);
    } finally {
      db.close();
    }
  });
});
