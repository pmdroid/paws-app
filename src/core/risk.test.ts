import { describe, expect, test } from "bun:test";
import { classifyRisk, highRiskGlobError, parseHighRiskPathsFile, riskLine } from "./risk";

const PAWS_APP = [
  "src/auth/**",
  "src/credentials/**",
  "src/runner-identity/**",
  "src/db/migrations.ts",
  ".github/workflows/**",
  ".agents/closeout.yaml",
  ".agents/skills/review-paws/**",
  "src/closeout-spec/**",
];

describe("classifyRisk", () => {
  test("a candidate that changes no high-risk path is normal", () => {
    expect(classifyRisk(["docs/smoke-test.md", "src/loop/brief.ts"], PAWS_APP)).toEqual({
      tier: "normal",
      paths: [],
    });
  });

  test("a candidate with no changed paths or no globs is normal", () => {
    expect(classifyRisk([], PAWS_APP).tier).toBe("normal");
    expect(classifyRisk(["src/auth/session.ts"], []).tier).toBe("normal");
  });

  test("a changed path under a high-risk directory makes the candidate high", () => {
    expect(
      classifyRisk(["README.md", "src/auth/session.ts", "src/auth/deep/token.ts"], PAWS_APP),
    ).toEqual({ tier: "high", paths: ["src/auth/deep/token.ts", "src/auth/session.ts"] });
  });

  test("dot directories and single files match", () => {
    expect(
      classifyRisk([".github/workflows/ci.yml", "src/db/migrations.ts"], PAWS_APP).paths,
    ).toEqual([".github/workflows/ci.yml", "src/db/migrations.ts"]);
  });

  test("a glob matches the whole path, not a prefix or a sibling", () => {
    expect(
      classifyRisk(["src/authx/a.ts", "src/db/migrations.test.ts", "lib/src/auth/a.ts"], PAWS_APP)
        .tier,
    ).toBe("normal");
  });

  test("a negated or escaping glob never matches", () => {
    expect(classifyRisk(["src/loop/brief.ts"], ["!src/auth/**", "../**"]).tier).toBe("normal");
  });

  test("a path listed twice is reported once", () => {
    expect(classifyRisk(["src/auth/a.ts", "src/auth/a.ts"], PAWS_APP).paths).toEqual([
      "src/auth/a.ts",
    ]);
  });
});

describe("parseHighRiskPathsFile", () => {
  test("reads one glob per line and skips comments, blanks and invalid lines", () => {
    expect(
      parseHighRiskPathsFile(
        "# Paths a person approves\n\nsrc/auth/**\r\n  infra/*.tf  \n!src/auth/**\n/abs\nsrc/auth/**\n",
      ),
    ).toEqual(["src/auth/**", "infra/*.tf"]);
  });
});

describe("highRiskGlobError", () => {
  test("accepts repository globs and refuses the rest", () => {
    expect(highRiskGlobError("src/auth/**")).toBeNull();
    expect(highRiskGlobError("")).not.toBeNull();
    expect(highRiskGlobError("!src/**")).not.toBeNull();
    expect(highRiskGlobError("/src/**")).not.toBeNull();
    expect(highRiskGlobError("src/../x")).not.toBeNull();
    expect(highRiskGlobError("src\\auth")).not.toBeNull();
  });
});

describe("riskLine", () => {
  test("names the tier and the matched paths", () => {
    expect(riskLine({ tier: "high", paths: ["src/auth/session.ts"] })).toBe(
      "Risk: high — `src/auth/session.ts`",
    );
    expect(riskLine({ tier: "normal", paths: [] })).toBe(
      "Risk: normal — no high-risk path changed",
    );
  });

  test("lists at most twenty paths", () => {
    const paths = Array.from({ length: 23 }, (_, index) => `src/auth/${index}.ts`);
    expect(riskLine({ tier: "high", paths })).toEndWith("and 3 more");
  });
});
