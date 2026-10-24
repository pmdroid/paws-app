import type { Database } from "bun:sqlite";

export function countLinearRequest(db: Database, itemId: string, caller: string): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO linear_item_request(item_id,requests) VALUES(?,1)
       ON CONFLICT(item_id) DO UPDATE SET requests=requests+1`,
      [itemId],
    );
    db.run(
      `INSERT INTO linear_item_caller_request(item_id,caller,requests) VALUES(?,?,1)
       ON CONFLICT(item_id,caller) DO UPDATE SET requests=requests+1`,
      [itemId, caller],
    );
  })();
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

export function linearRequestsByCaller(db: Database, itemId: string): Record<string, number> {
  return Object.fromEntries(
    db
      .query<{ caller: string; requests: number }, [string]>(
        "SELECT caller,requests FROM linear_item_caller_request WHERE item_id=? ORDER BY caller",
      )
      .all(itemId)
      .map((row) => [row.caller, row.requests]),
  );
}
