import { expect, test } from "bun:test";
import { isTransient } from "../src/core";
import { startWorkspaceAccess } from "../src/workspace";
import { tempStore } from "./pglite";

function timeoutError() {
  return new DOMException("The operation timed out.", "TimeoutError");
}

async function withRuntime(
  installation: () => Promise<{ id: string; name: string }>,
  run: (runtime: ReturnType<typeof startWorkspaceAccess>, errors: () => number) => Promise<void>,
) {
  const { db, close } = await tempStore();
  let errors = 0;
  const runtime = startWorkspaceAccess({
    store: db,
    publicUrl: "https://paws.example",
    clientId: "client",
    accessRetryBaseMs: 5,
    retryable: isTransient,
    onError: () => errors++,
    memberships: {
      installation,
      async member() {
        throw new Error("not used");
      },
    },
  });
  try {
    await run(runtime, () => errors);
  } finally {
    await runtime.stop();
    await close();
  }
}

test("a timed-out installation read at startup retries instead of failing startup", async () => {
  let calls = 0;
  await withRuntime(
    async () => {
      if (++calls < 3) throw timeoutError();
      return { id: "org", name: "Workspace" };
    },
    async (runtime, errors) => {
      const access = await runtime.access;
      expect(access.organizationId).toBe("org");
      expect(calls).toBe(3);
      expect(errors()).toBe(0);
    },
  );
});

test("a permanent installation failure still rejects workspace access", async () => {
  let calls = 0;
  await withRuntime(
    async () => {
      calls++;
      throw new Error("A verified Linear app installation is required.");
    },
    async (runtime, errors) => {
      await expect(runtime.access).rejects.toThrow(
        "A verified Linear app installation is required.",
      );
      expect(calls).toBe(1);
      expect(errors()).toBe(1);
    },
  );
});

test("stopping while startup retries ends the retry", async () => {
  let calls = 0;
  await withRuntime(
    async () => {
      calls++;
      throw timeoutError();
    },
    async (runtime) => {
      const settled = runtime.access.then(
        () => "resolved",
        (error: Error) => error.message,
      );
      await Bun.sleep(20);
      await runtime.stop();
      expect(await settled).toBe("Workspace access is stopping.");
      const after = calls;
      await Bun.sleep(30);
      expect(calls).toBe(after);
    },
  );
});
