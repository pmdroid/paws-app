import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261027T0314_candidate_risk_matches",
  sql: `ALTER TABLE candidate_risk ADD COLUMN matches TEXT CHECK (matches IS NULL OR json_valid(matches));`,
};
