import { expect, test } from "bun:test";
import {
  cacheLinearMemberships,
  type AcceptedLinearEvent,
  type LinearMembershipReads,
} from "../src/linear";

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

function membershipEvent(type: string, action = "update"): AcceptedLinearEvent {
  return {
    dedupeKey: "membership-event",
    deliveryId: "delivery",
    source: "webhook",
    action: "other",
    sessionId: null,
    issueId: null,
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: JSON.stringify({ type, action }),
  };
}

test.each(["TeamMembership", "Team", "User", "PermissionChange"])(
  "%s webhooks clear membership without letting an older read refill the cache",
  async (type) => {
    let reads = 0;
    let teamIds = ["team"];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cached = cacheLinearMemberships({
      installation: async () => ({ id: "org", name: "Org" }),
      async member(organizationId, userId) {
        reads += 1;
        const identity = {
          organizationId,
          userId,
          active: true,
          guest: false,
          admin: false,
          teamIds,
        };
        if (reads === 2) await held;
        return identity;
      },
    });
    await cached.member("org", "person");
    const pending = cached.member("org", "other");
    cached.invalidate(
      membershipEvent(type, type === "PermissionChange" ? "teamAccessChanged" : "update"),
    );
    teamIds = [];
    release();
    await pending;
    expect((await cached.member("org", "person")).teamIds).toEqual([]);
    expect((await cached.member("org", "other")).teamIds).toEqual([]);
    expect(reads).toBe(4);
    cached.invalidate(membershipEvent("Issue"));
    cached.invalidate({ ...membershipEvent(type), source: "poll", deliveryId: null });
    await cached.member("org", "person");
    expect(reads).toBe(4);
  },
);
