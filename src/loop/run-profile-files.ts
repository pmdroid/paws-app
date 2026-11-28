import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDir } from "../acp";
import { keepRunProfileSteps, type Db } from "../db";
import { journalCaught } from "../journal";

const PROFILE_FILE = "agent-profile.json";

export async function moveRunProfileFiles(
  store: Db,
  pawsRoot: string,
  now: () => number = Date.now,
): Promise<number> {
  const runs = dirname(runDir(pawsRoot, "run"));
  if (!existsSync(runs)) return 0;
  let moved = 0;
  for (const runId of readdirSync(runs)) {
    let file = runId;
    let record: unknown;
    try {
      file = join(runDir(pawsRoot, runId), PROFILE_FILE);
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        journalCaught(error, "loop.moveRunProfileFiles.parse", null, file);
      continue;
    }
    const kept = await store.transaction((q) => keepRunProfileSteps(q, runId, record, now()));
    if (kept === null) continue;
    rmSync(file, { force: true });
    moved += 1;
  }
  return moved;
}
