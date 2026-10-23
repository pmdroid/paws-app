import type { Database } from "bun:sqlite";

export function countLinearRequest(db: Database, itemId: string): void {
  db.run(
    `INSERT INTO linear_item_request(item_id,requests) VALUES(?,1)
     ON CONFLICT(item_id) DO UPDATE SET requests=requests+1`,
    [itemId],
  );
}

export function linearRequestsByItem(db: Database): Map<string, number> {
  return new Map(
    db
      .query<{ itemId: string; requests: number }, []>(
        "SELECT item_id AS itemId,requests FROM linear_item_request",
      )
      .all()
      .map((row) => [row.itemId, row.requests]),
  );
}
