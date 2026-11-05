/** "Queued, 2nd in line. 4 of 4 runner slots are busy." */
export function queueLine(entry: {
  position: number;
  busySlots: number;
  totalSlots: number;
}): string {
  const slots = entry.totalSlots === 1 ? "runner slot" : "runner slots";
  const verb = entry.busySlots === 1 ? "is" : "are";
  return `Queued, ${ordinal(entry.position)} in line. ${entry.busySlots} of ${entry.totalSlots} ${slots} ${verb} busy.`;
}

export function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][value % 10] ?? "th");
  return `${value}${suffix}`;
}

const PLACES = [
  "First",
  "Second",
  "Third",
  "Fourth",
  "Fifth",
  "Sixth",
  "Seventh",
  "Eighth",
  "Ninth",
  "Tenth",
];

/**
 * "Second in the acme/platform queue", or "Second in the acme/platform queue for Billing" in a
 * Linear project's lane.
 */
export function mergeQueueLine(entry: {
  position: number;
  repository: string;
  lane?: string;
  laneName?: string | null;
}): string {
  const place = PLACES[entry.position - 1] ?? ordinal(entry.position);
  const lane = entry.lane ? ` for ${entry.laneName ?? "its Linear project"}` : "";
  return `${place} in the ${entry.repository} queue${lane}`;
}
