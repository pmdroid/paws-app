import { expect, test } from "bun:test";
import { insertQueuedItem } from "../src/db";
import { createAdmission, dispatch, type ItemAdmission } from "../src/scheduler";
import { tempStore } from "./pglite";

function countingAdmission(db: Parameters<typeof createAdmission>[0]["db"]) {
  const base = createAdmission({ db });
  const seen = { passes: 0 };
  const admission: ItemAdmission = {
    ...base,
    steps: {
      ...base.steps,
      canStart: function* (q, itemId) {
        seen.passes += 1;
        return yield* base.steps.canStart(q, itemId);
      },
    },
  };
  return { admission, seen };
}

const started = () => new Promise((resolve) => setTimeout(resolve, 0));

test("calls made before a pass starts share that pass", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "only", now: 1 });
    const { admission, seen } = countingAdmission(db);
    const results = await Promise.all([1, 2, 3].map(() => dispatch(db, { now: 1000, admission })));
    expect(seen.passes).toBe(1);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  } finally {
    await close();
  }
});

test("calls made during a running pass fold into one follow-up pass", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "only", now: 1 });
    const { admission, seen } = countingAdmission(db);
    const first = dispatch(db, { now: 1000, admission });
    await started();
    const later = [1, 2, 3].map(() => dispatch(db, { now: 1000, admission }));
    expect(later[0]).toBe(later[2]);
    await Promise.all([first, ...later]);
    expect(seen.passes).toBe(2);
    await dispatch(db, { now: 1001, admission });
    expect(seen.passes).toBe(3);
  } finally {
    await close();
  }
});

test("a failed pass doesn't block the passes queued after it", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "only", now: 1 });
    const base = createAdmission({ db });
    let fail = true;
    const admission: ItemAdmission = {
      ...base,
      steps: {
        ...base.steps,
        canStart: function* (q, itemId) {
          if (fail) {
            fail = false;
            throw new Error("pass failed");
          }
          return yield* base.steps.canStart(q, itemId);
        },
      },
    };
    const first = dispatch(db, { now: 1000, admission });
    await started();
    const second = dispatch(db, { now: 1000, admission });
    await expect(first).rejects.toThrow("pass failed");
    expect(Array.isArray(await second)).toBe(true);
    expect(fail).toBe(false);
  } finally {
    await close();
  }
});
