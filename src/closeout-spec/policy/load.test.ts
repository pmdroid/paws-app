import { expect, test } from "bun:test";
import { createFakeGitReader } from "./git";
import { confirmedOriginMain } from "./load";

const repo = "/acme/repo";

test("confirmedOriginMain retries a moving main and returns the second commit", () => {
  const git = createFakeGitReader();
  const second = "b".repeat(40);
  const fetch = git.fetchOriginMain;
  git.fetchOriginMain = (path) => {
    const result = fetch(path);
    git.commit = second;
    return result;
  };
  expect(confirmedOriginMain({ repo, git })).toEqual({ ok: true, commit: second });
  expect(git.calls).toEqual([
    `fetch ${repo}`,
    `ls-remote ${repo}`,
    `fetch ${repo}`,
    `ls-remote ${repo}`,
  ]);
});

test("confirmedOriginMain reports both final SHAs after three disagreements", () => {
  const git = createFakeGitReader();
  const fetch = git.fetchOriginMain;
  let attempt = 0;
  git.fetchOriginMain = (path) => {
    git.commit = String(++attempt).repeat(40);
    git.remoteStdout = `${String(attempt + 1).repeat(40)}\trefs/heads/main\n`;
    return fetch(path);
  };
  expect(confirmedOriginMain({ repo, git })).toEqual({
    ok: false,
    message: `origin/main is unavailable (fetched ${"3".repeat(40)}, remote ${"4".repeat(40)} after 3 attempts)`,
  });
  expect(git.calls).toEqual(
    Array(3)
      .fill([`fetch ${repo}`, `ls-remote ${repo}`])
      .flat(),
  );
});

test("confirmedOriginMain fails immediately on a fetch error", () => {
  const git = createFakeGitReader();
  git.fetchError = "acme fetch failed";
  expect(confirmedOriginMain({ repo, git })).toEqual({
    ok: false,
    message: "origin/main is unavailable: acme fetch failed",
  });
  expect(git.calls).toEqual([`fetch ${repo}`]);
});

test("confirmedOriginMain fails immediately on an ls-remote error", () => {
  const git = createFakeGitReader();
  git.remoteError = "acme remote failed";
  expect(confirmedOriginMain({ repo, git })).toEqual({
    ok: false,
    message: "origin/main is unavailable: acme remote failed",
  });
  expect(git.calls).toEqual([`fetch ${repo}`, `ls-remote ${repo}`]);
});
