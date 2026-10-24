import { deflateSync } from "node:zlib";

/** A screen in a test: a flat background with filled rectangles on it. */
export type Rect = { x: number; y: number; width: number; height: number; rgb: number };

/** An 8-bit RGB PNG of `width` × `height` with the rectangles painted in order. */
export function screenshotPng(
  width: number,
  height: number,
  rects: readonly Rect[] = [],
  background = 0xf4f1ff,
): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const paint = (x: number, y: number, rgb: number) => {
    const at = y * stride + 1 + x * 3;
    raw[at] = (rgb >> 16) & 0xff;
    raw[at + 1] = (rgb >> 8) & 0xff;
    raw[at + 2] = rgb & 0xff;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, background);
  for (const rect of rects)
    for (let y = rect.y; y < Math.min(height, rect.y + rect.height); y++)
      for (let x = rect.x; x < Math.min(width, rect.x + rect.width); x++) paint(x, y, rect.rgb);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}
