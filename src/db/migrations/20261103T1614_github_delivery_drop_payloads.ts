import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T1614_github_delivery_drop_payloads",
  sql: `UPDATE github_delivery SET payload = '' WHERE payload <> '';`,
};
