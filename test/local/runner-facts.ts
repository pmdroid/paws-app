import { writeFileSync } from "node:fs";
import { isNotNull } from "drizzle-orm";
import { pgSchema, type Db } from "../../src/db";

export async function writeRunnerFacts(db: Db, path: string, commandIds: string[]): Promise<void> {
  const inCommandOrder = <T extends { commandId: string }>(rows: T[]) =>
    rows.sort((a, b) => commandIds.indexOf(a.commandId) - commandIds.indexOf(b.commandId));
  const { runnerResult, runnerEvent, runnerQuestionAnswer, runnerTranscript } = pgSchema;
  const results = inCommandOrder(await db.orm.select().from(runnerResult));
  const events = await db.orm.select().from(runnerEvent).orderBy(runnerEvent.receivedAt);
  const answers = await db.orm.select().from(runnerQuestionAnswer);
  const transcripts = inCommandOrder(
    await db.orm.select().from(runnerTranscript).where(isNotNull(runnerTranscript.uri)),
  );
  const facts = {
    results: results.map((row) => row.payload),
    events: events.map((row) => row.payload),
    answers: answers.map((row) => row.answer),
    transcripts: transcripts.map((row) => [row.executionId, row.sealedSize, row.sha256, row.uri]),
  };
  writeFileSync(path, JSON.stringify(facts));
}
