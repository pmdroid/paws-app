import { expect, test } from "bun:test";
import { screenshotPng } from "../../test/png";
import { compareScreenshots } from "./screenshot-diff";

const SCREEN = [
  { x: 20, y: 20, width: 300, height: 40, rgb: 0x111111 },
  { x: 20, y: 100, width: 200, height: 120, rgb: 0xff7a3d },
];

test("the same screen encoded differently looks the same", async () => {
  const png = screenshotPng(400, 300, SCREEN);
  const webp = await new Bun.Image(png).webp({ lossless: true }).bytes();
  expect(await compareScreenshots(png, webp)).toEqual({ same: true, changed: 0, total: 120_000 });
});

test("a changed timestamp of a few pixels stays within tolerance", async () => {
  const before = screenshotPng(400, 300, SCREEN);
  const after = screenshotPng(400, 300, [
    ...SCREEN,
    { x: 350, y: 280, width: 10, height: 8, rgb: 0x333333 },
  ]);
  expect(await compareScreenshots(before, after)).toEqual({
    same: true,
    changed: 80,
    total: 120_000,
  });
});

test("a faint colour shift from anti-aliasing doesn't count", async () => {
  const before = screenshotPng(400, 300, SCREEN);
  const after = screenshotPng(400, 300, [
    ...SCREEN,
    { x: 0, y: 250, width: 400, height: 50, rgb: 0xe8e5f5 },
  ]);
  expect((await compareScreenshots(before, after))?.same).toBe(true);
});

test("a moved button is a changed screen", async () => {
  const before = screenshotPng(400, 300, SCREEN);
  const after = screenshotPng(400, 300, [
    SCREEN[0]!,
    { x: 180, y: 100, width: 200, height: 120, rgb: 0xff7a3d },
  ]);
  const compared = await compareScreenshots(before, after);
  expect(compared?.same).toBe(false);
  expect(compared!.changed).toBeGreaterThan(120);
});

test("another size is a changed screen, and a file that isn't an image can't be compared", async () => {
  const before = screenshotPng(400, 300, SCREEN);
  expect((await compareScreenshots(before, screenshotPng(390, 300, SCREEN)))?.same).toBe(false);
  expect(await compareScreenshots(before, new Uint8Array([1, 2, 3]))).toBeNull();
});
