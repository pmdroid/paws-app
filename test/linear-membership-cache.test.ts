import { expect, test } from "bun:test";
import { cacheLinearMemberships, type LinearMembershipReads } from "../src/linear";

test("a member is read once until a user change or fifteen minutes pass", async () => {
  let reads = 0;
  let now = 0;
  const memberships: LinearMembershipReads = {
    installation: async () => ({ id: "org", name: "Org" }),
    async member(organizationId, userId) {
      reads += 1;
      return {
        userId,
        organizationId,
        active: true,
        guest: false,
        admin: false,
        teamIds: ["team"],
      };
    },
  };
  const cached = cacheLinearMemberships(memberships, () => now);
  await cached.member("org", "person");
  await cached.member("org", "person");
  expect(reads).toBe(1);
  await cached.member("org", "other");
  expect(reads).toBe(2);
  cached.forget();
  await cached.member("org", "person");
  expect(reads).toBe(3);
  now = 15 * 60_000;
  await cached.member("org", "person");
  expect(reads).toBe(4);
});
