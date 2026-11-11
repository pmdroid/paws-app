import { Database } from "bun:sqlite";
import { countItems } from "../db/items";

const db = new Database(":memory:");
console.log(countItems(db, "abc"));
