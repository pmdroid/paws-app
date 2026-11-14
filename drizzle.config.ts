import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema-pg/index.ts",
  out: "./src/db/drizzle-pg",
});
