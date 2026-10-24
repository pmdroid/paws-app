import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { insertQueuedItem, migrate, openDatabase } from "../src/db";
import { startPaws } from "../src/index";
import { tempHome } from "./helpers";

test("startup without a Linear workspace says why and admits nothing", async () => {
  const home = tempHome();
  const seed = openDatabase(join(home, "paws.db"));
  migrate(seed);
  insertQueuedItem(seed, { id: "waiting", now: Date.now() });
  seed.close();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const paws = startPaws({
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
    PAWS_NO_TUNNEL: "1",
  });
  try {
    const ticked = () =>
      paws.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM job WHERE queue='scheduler.tick' AND run_at>created_at",
        )
        .get()!.n > 0;
    for (let waited = 0; !ticked() && waited < 2_000; waited += 25) await Bun.sleep(25);
    expect(ticked()).toBe(true);
    expect(
      paws.db.query("SELECT item_id FROM scheduler_admission WHERE item_id='waiting'").all(),
    ).toEqual([]);
    expect(errors.mock.calls.flat().join("\n")).toContain("Linear workspace");
  } finally {
    await paws.stop();
    errors.mockRestore();
  }
});
