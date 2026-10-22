import type { QueuePosition } from "../db";

const ORDINAL = new Intl.PluralRules("en-US", { type: "ordinal" });
const SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };

/** "Queued, 2nd in line. 4 of 4 runner slots are busy." */
export function queuePositionText(
  position: Pick<QueuePosition, "position" | "busySlots" | "totalSlots">,
): string {
  const place = `${position.position}${SUFFIX[ORDINAL.select(position.position)] ?? "th"}`;
  const slots =
    position.totalSlots === 1
      ? `${position.busySlots} of 1 runner slot is busy.`
      : `${position.busySlots} of ${position.totalSlots} runner slots are busy.`;
  return `Queued, ${place} in line. ${slots}`;
}
