import { expect, test } from "bun:test";
import { githubDeliveryLine } from "./github-delivery";

test("the GitHub settings line names the last webhook delivery", () => {
  expect(githubDeliveryLine({ event: "check_suite", receivedAt: 0 }, 4 * 60_000)).toBe(
    " Last GitHub webhook: check_suite, 4m ago.",
  );
  expect(githubDeliveryLine(null)).toBe(" No GitHub webhook has arrived yet.");
  expect(githubDeliveryLine(undefined)).toBe("");
});
