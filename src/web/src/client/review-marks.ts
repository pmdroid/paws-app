/** Marks a person draws on review screenshots. No DOM, so the page markup can show them. */

export type Stroke = (readonly [number, number])[];

export const INK = "#e5484d";

/** Marks drawn on each open review, by question and screenshot, kept until they are sent. */
const drawn = new Map<string, Map<string, Stroke[]>>();

export function strokesOf(
  questionId: string,
  shots: readonly { id: string }[],
): Map<string, Stroke[]> {
  const marks = drawn.get(questionId) ?? new Map<string, Stroke[]>();
  for (const shot of shots) if (!marks.has(shot.id)) marks.set(shot.id, []);
  drawn.set(questionId, marks);
  return marks;
}

/** The strokes drawn on one screenshot of an open review. */
export function drawnStrokes(questionId: string, evidenceId: string): readonly Stroke[] {
  return drawn.get(questionId)?.get(evidenceId) ?? [];
}

/** How many marks a person drew on the review's screenshots so far. */
export function drawnMarkCount(questionId: string): number {
  return [...(drawn.get(questionId)?.values() ?? [])].reduce((sum, list) => sum + list.length, 0);
}

export function forgetDrawnMarks(questionId: string): void {
  drawn.delete(questionId);
}

/** SVG strokes over a screenshot, in the image's own 0..1 coordinates. */
export function strokesOverlay(strokes: readonly Stroke[]): string {
  if (!strokes.length) return "";
  const lines = strokes
    .map((stroke) => {
      const points = (stroke.length > 1 ? stroke : [stroke[0]!, stroke[0]!])
        .map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`)
        .join(" ");
      return `<polyline points="${points}" />`;
    })
    .join("");
  return `<svg class="review-marks" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>`;
}
