import happyPath from "./happy-path";
import type { Proof } from "./harness";

export default {
  ...happyPath,
  covers: ["src/github/readiness.ts", "src/github/fake.ts"],
  summary:
    "A repository with no candidate or base CI and no required checks merges an accepted head pushed more than five minutes ago.",
  noCi: true,
} satisfies Proof;
