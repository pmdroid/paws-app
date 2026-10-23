import { expect, test } from "bun:test";
import { createProjectFixture } from "./local/project-fixture";

const SIX_HOURS = 6 * 60 * 60_000;

async function approvedProject(f: ReturnType<typeof createProjectFixture>) {
  const preview = await f.projects.preview(f.actor, f.selection, AbortSignal.timeout(10_000));
  await f.projects.approve(f.actor, preview.id, preview.generation, AbortSignal.timeout(10_000));
  f.projects.register(f.jobs);
  await f.jobs.tick();
  return preview.id;
}

test("an approved project makes no membership read while the stored rows are fresh", async () => {
  const f = createProjectFixture();
  try {
    await approvedProject(f);
    const reads = f.memberReads;
    for (let pass = 0; pass < 4; pass++) {
      f.clock.advance(30_000);
      await f.jobs.tick();
    }
    expect(f.memberReads).toBe(reads);
    f.clock.advance(SIX_HOURS);
    await f.jobs.tick();
    expect(f.memberReads).toBe(reads + 2);
  } finally {
    await f.close();
  }
});
