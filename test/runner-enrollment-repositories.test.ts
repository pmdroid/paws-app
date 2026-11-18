import { expect, test } from "bun:test";
import { createRunnerHttp, type RunnerControl } from "../src/runner-control";

test("Add a runner starts the runner with All repositories", async () => {
  const inputs: unknown[] = [];
  const control = {
    async createEnrollment(_principal: unknown, input: unknown) {
      inputs.push(input);
      return { id: "enrollment", token: "token", expiresAt: 1 };
    },
  } as unknown as RunnerControl;
  const http = createRunnerHttp(control, { hostConfig: async () => null });

  const response = await http.browser(
    new Request("https://localhost/api/runners/enrollments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop" }),
    }),
    { workspaceId: "acme", userId: "owner" } as never,
    [],
  );

  expect(response?.status).toBe(200);
  expect(inputs).toEqual([{ name: "laptop" }]);
});
