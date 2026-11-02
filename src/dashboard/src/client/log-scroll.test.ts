import { expect, test } from "bun:test";
import { captureLogs, restoreLogs, type LogNode } from "./log-scroll";

function log(key: string, scrollHeight: number, scrollTop = 0, follow = true): LogNode {
  return {
    scrollTop,
    scrollHeight,
    clientHeight: 100,
    getAttribute: (name) => (name === "data-log" ? key : null),
    hasAttribute: (name) => name === "data-follow" && follow,
  };
}

function root(...nodes: LogNode[]) {
  return { querySelectorAll: () => nodes };
}

test("a refresh keeps a scrolled-up log in place and follows a log read at its bottom", () => {
  const before = captureLogs(root(log("reading", 400, 120), log("tail", 400, 300)));
  const reading = log("reading", 460);
  const tail = log("tail", 460);
  restoreLogs(root(reading, tail), before);
  expect(reading.scrollTop).toBe(120);
  expect(tail.scrollTop).toBe(460);
});

test("a follow log seen for the first time starts at its newest line", () => {
  const fresh = log("activity", 500);
  const plain = log("closeout", 500, 0, false);
  restoreLogs(root(fresh, plain), []);
  expect(fresh.scrollTop).toBe(500);
  expect(plain.scrollTop).toBe(0);
});
