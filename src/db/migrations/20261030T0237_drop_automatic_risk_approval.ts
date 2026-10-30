import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261030T0237_drop_automatic_risk_approval",
  sql: `DROP TABLE IF EXISTS automatic_risk_approval;`,
};
