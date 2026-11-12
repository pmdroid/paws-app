import type { Logger } from "drizzle-orm";
import type { Db } from "../src/db";

type Session = { logger: Logger; options: { logger?: Logger } };

export async function queriesDuring(db: Db, read: () => Promise<unknown>): Promise<string[]> {
  const session = (db.orm as unknown as { session: Session }).session;
  const { logger, options } = session;
  const before = options.logger;
  const seen: string[] = [];
  const recording: Logger = { logQuery: (query) => void seen.push(query) };
  session.logger = recording;
  options.logger = recording;
  try {
    await read();
  } finally {
    session.logger = logger;
    options.logger = before;
  }
  return seen;
}
