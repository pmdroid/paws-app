import { readFileSync } from "node:fs";

const GIB = 1024 ** 3;
const POOL_FREE_SHARE = 0.2;
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const VOLUME_GROUP = "paws-issue-vms";
const OUTPUT_DIR = "/run/paws-issue-vm-disk";

export type IssueVmDiskHelper = (operation: string) => Promise<string>;

export type IssueVmPool = { sizeBytes: number; usedBytes: number };

export type IssueVmDisk = { id: string; sizeBytes: number };

export type IssueVmDiskSize = { diskGb: number; memoryGb: number };

export type IssueVmClone =
  | { ok: true; path: string }
  | { ok: false; reason: "pool_full"; needBytes: number; freeBytes: number };

function wholeNumber(text: string | undefined): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Not a byte count: ${text}`);
  return value;
}

function lines(output: string): string[][] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/));
}

export function issueVmDisks(helper: IssueVmDiskHelper) {
  async function pool(): Promise<IssueVmPool> {
    const [row] = lines(await helper("pool"));
    if (row === undefined) throw new Error("The issue VM pool reported nothing.");
    return { sizeBytes: wholeNumber(row[0]), usedBytes: wholeNumber(row[1]) };
  }

  async function list(): Promise<IssueVmDisk[]> {
    return lines(await helper("list"))
      .filter(([id]) => id !== undefined && ID.test(id))
      .map(([id, size]) => ({ id: id!, sizeBytes: wholeNumber(size) }));
  }

  async function clone(id: string, size: IssueVmDiskSize): Promise<IssueVmClone> {
    if (!ID.test(id)) throw new Error(`Not an issue VM id: ${id}`);
    const disks = await list();
    const path = `/dev/${VOLUME_GROUP}/${id}`;
    if (disks.some((disk) => disk.id === id)) return { ok: true, path };
    const { sizeBytes, usedBytes } = await pool();
    const usable = sizeBytes * (1 - POOL_FREE_SHARE);
    const committed = disks.reduce((sum, disk) => sum + disk.sizeBytes + size.memoryGb * GIB, 0);
    const needBytes = (size.diskGb + size.memoryGb) * GIB;
    const freeBytes = Math.max(0, Math.floor(usable - Math.max(committed, usedBytes)));
    if (needBytes > freeBytes) return { ok: false, reason: "pool_full", needBytes, freeBytes };
    const created = (await helper(`create-${id}-${size.diskGb}`)).trim();
    if (created !== path) throw new Error(`The issue VM disk helper created ${created}.`);
    return { ok: true, path };
  }

  async function remove(deleting: readonly string[]): Promise<string[]> {
    const wanted = new Set(deleting);
    const removed: string[] = [];
    for (const disk of await list()) {
      if (!wanted.has(disk.id)) continue;
      await helper(`delete-${disk.id}`);
      removed.push(disk.id);
    }
    return removed;
  }

  return { pool, list, clone, remove };
}

export type IssueVmDisks = ReturnType<typeof issueVmDisks>;

export function systemdIssueVmDiskHelper(
  spawn: typeof Bun.spawn = Bun.spawn,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): IssueVmDiskHelper {
  return async (operation) => {
    const child = spawn(
      [
        "/usr/bin/systemctl",
        "start",
        "--no-ask-password",
        `paws-issue-vm-disk@${operation}.service`,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream).text(),
    ]);
    if (code !== 0)
      throw new Error(`The issue VM disk helper failed ${operation}: ${stderr.trim() || code}`);
    return read(`${OUTPUT_DIR}/${operation}.out`);
  };
}

export function createFakeIssueVmDiskHelper(input: { poolBytes: number; baseBytes: number }) {
  const volumes = new Map<string, number>();
  const calls: string[] = [];
  const helper: IssueVmDiskHelper = async (operation) => {
    calls.push(operation);
    if (operation === "pool") {
      const used = [...volumes.values()].reduce((sum, bytes) => sum + bytes / 10, 0);
      return `${input.poolBytes} ${Math.floor(used)}\n`;
    }
    if (operation === "list")
      return [
        `  base ${input.baseBytes}\n`,
        ...[...volumes].map(([id, bytes]) => `  ${id} ${bytes}\n`),
      ].join("");
    const create = /^create-([0-9A-Z]{26})-([0-9]+)$/.exec(operation);
    if (create) {
      volumes.set(create[1]!, Math.max(input.baseBytes, Number(create[2]) * GIB));
      return `/dev/${VOLUME_GROUP}/${create[1]}\n`;
    }
    const remove = /^delete-([0-9A-Z]{26})$/.exec(operation);
    if (remove) {
      volumes.delete(remove[1]!);
      return "";
    }
    throw new Error(`Unknown operation: ${operation}`);
  };
  return { helper, calls, volumes };
}
