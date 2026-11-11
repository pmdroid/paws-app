import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

export const citext = customType<{ data: string }>({ dataType: () => "citext" });

function parsedText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => sql`${JSON.stringify(value)}::text::jsonb`,
  fromDriver: parsedText,
});
