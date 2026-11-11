import { Database } from "bun:sqlite";
import { countItems } from "../db/items";
import { sqliteDb } from "../db/db";

const db = new Database(":memory:");
console.log(await countItems(sqliteDb(db), "abc"));
