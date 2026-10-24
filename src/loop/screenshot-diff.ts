import { inflateSync } from "node:zlib";

/** A pixel counts as changed when one channel moves by more than this, out of 255. */
export const SCREENSHOT_COLOUR_THRESHOLD = 24;

/** Two screenshots look the same while fewer than this share of their pixels changed. */
export const SCREENSHOT_CHANGED_SHARE = 0.001;

/** Screens larger than this are not decoded; they only match by bytes. */
const MAX_PIXELS = 4096 * 4096;

export type ScreenshotComparison = {
  /** Within tolerance: anti-aliasing or a changing timestamp, not a changed screen. */
  same: boolean;
  changed: number;
  total: number;
};

/**
 * Decodes both images and counts the pixels whose colour moved beyond
 * {@link SCREENSHOT_COLOUR_THRESHOLD}. Different sizes are a changed screen.
 * Returns null when either file can't be decoded, so the caller asks.
 */
export async function compareScreenshots(
  before: Uint8Array,
  after: Uint8Array,
): Promise<ScreenshotComparison | null> {
  const [a, b] = await Promise.all([decode(before), decode(after)]);
  if (a === null || b === null) return null;
  const total = Math.max(a.width * a.height, b.width * b.height);
  if (a.width !== b.width || a.height !== b.height) return { same: false, changed: total, total };
  let changed = 0;
  for (let at = 0; at < a.rgba.length; at += 4) {
    if (
      Math.abs(a.rgba[at]! - b.rgba[at]!) > SCREENSHOT_COLOUR_THRESHOLD ||
      Math.abs(a.rgba[at + 1]! - b.rgba[at + 1]!) > SCREENSHOT_COLOUR_THRESHOLD ||
      Math.abs(a.rgba[at + 2]! - b.rgba[at + 2]!) > SCREENSHOT_COLOUR_THRESHOLD ||
      Math.abs(a.rgba[at + 3]! - b.rgba[at + 3]!) > SCREENSHOT_COLOUR_THRESHOLD
    )
      changed += 1;
  }
  return { same: changed < total * SCREENSHOT_CHANGED_SHARE, changed, total };
}

type Pixels = { width: number; height: number; rgba: Uint8Array };

/** Any format Bun.Image reads, re-encoded as plain PNG, then inflated to RGBA. */
async function decode(bytes: Uint8Array): Promise<Pixels | null> {
  try {
    const png = await new Bun.Image(bytes.slice(), { maxPixels: MAX_PIXELS })
      .png({ compressionLevel: 0 })
      .bytes();
    return decodePng(png);
  } catch {
    return null;
  }
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 8-bit RGB or RGBA, not interlaced: what Bun.Image writes. */
export function decodePng(png: Uint8Array): Pixels | null {
  if (png.length < 33 || SIGNATURE.some((byte, at) => png[at] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0) return null;
      if (colour === 6) channels = 4;
      else if (colour === 2) channels = 3;
      else return null;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (channels === 0 || width === 0 || height === 0 || width * height > MAX_PIXELS) return null;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels]! : 0;
      const up = previous[x]!;
      const corner = x >= channels ? previous[x - channels]! : 0;
      if (filter === 1) line[x] = line[x]! + left;
      else if (filter === 2) line[x] = line[x]! + up;
      else if (filter === 3) line[x] = line[x]! + ((left + up) >> 1);
      else if (filter === 4) line[x] = line[x]! + paeth(left, up, corner);
      else if (filter !== 0) return null;
    }
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      const from = x * channels;
      rgba[to] = line[from]!;
      rgba[to + 1] = line[from + 1]!;
      rgba[to + 2] = line[from + 2]!;
      rgba[to + 3] = channels === 4 ? line[from + 3]! : 255;
    }
    previous = line;
  }
  return { width, height, rgba };
}

function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  if (toLeft <= toUp && toLeft <= toCorner) return left;
  return toUp <= toCorner ? up : corner;
}
