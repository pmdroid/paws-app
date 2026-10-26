import { journalCaught } from "../journal";
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  renameSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runnerJobDirectory, type RunnerSpool } from "../runner-execution";

export const RunnerAnswerSchema = z.strictObject({
  requestId: z.uuid(),
  answer: z.string().min(1).max(65_536),
});
export type RunnerAnswer = z.infer<typeof RunnerAnswerSchema>;

export function runnerFollowUpRequestId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error("Invalid follow-up sequence");
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

export function removeRunnerAnswers(spool: RunnerSpool, executionId: string): void {
  if (process.getuid?.() !== spool.runnerUid) throw new Error("Only the runner may remove answers");
  try {
    const directory = `${runnerJobDirectory(spool, executionId)}/answers`;
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    journalCaught(
      error,
      "runner-answers.removeRunnerAnswers.runnerJobDirectory",
      null,
      "optional file may be absent",
    );
  }
}

function openAnswers(spool: RunnerSpool, executionId: string, create: boolean): number {
  const directory = `${runnerJobDirectory(spool, executionId)}/answers`;
  if (create) {
    if (process.getuid?.() !== spool.runnerUid)
      throw new Error("Only the runner may publish answers");
    try {
      mkdirSync(directory, { mode: 0o750 });
      const fd = openSync(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fchownSync(fd, spool.runnerUid, spool.agentGid);
        fchmodSync(fd, 0o750);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      journalCaught(error, "runner-answers.openAnswers.mkdirSync", null, "path may already exist");
    }
  }
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const info = fstatSync(fd);
  if (
    info.uid !== spool.runnerUid ||
    info.gid !== spool.agentGid ||
    (info.mode & 0o7777) !== 0o750
  ) {
    closeSync(fd);
    throw new Error("Unsafe runner answer directory");
  }
  return fd;
}

export function readRunnerAnswer(
  spool: RunnerSpool,
  executionId: string,
  requestId: string,
): RunnerAnswer | null {
  z.uuid().parse(requestId);
  let directory: number | undefined;
  let file: number | undefined;
  let published: number | undefined;
  try {
    directory = openAnswers(spool, executionId, false);
    published = openSync(
      `/proc/self/fd/${directory}/${requestId}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const metadata = fstatSync(published);
    if (
      metadata.uid !== spool.runnerUid ||
      metadata.gid !== spool.agentGid ||
      (metadata.mode & 0o7777) !== 0o750
    )
      throw new Error("Unsafe runner answer directory");
    file = openSync(
      `/proc/self/fd/${published}/answer.json`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(file);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== spool.runnerUid ||
      info.gid !== spool.agentGid ||
      (info.mode & 0o7777) !== 0o640 ||
      info.size > 524_288
    )
      throw new Error("Unsafe runner answer file");
    const answer = RunnerAnswerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (answer.requestId !== requestId) throw new Error("Runner answer identity mismatch");
    return answer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(
        error,
        "runner-answers.readRunnerAnswer.openAnswers",
        null,
        "optional file may be absent",
      );
      return null;
    }
    throw error;
  } finally {
    if (file !== undefined) closeSync(file);
    if (published !== undefined) closeSync(published);
    if (directory !== undefined) closeSync(directory);
  }
}

export function publishRunnerAnswer(
  spool: RunnerSpool,
  executionId: string,
  input: RunnerAnswer,
): void {
  const answer = RunnerAnswerSchema.parse(input);
  const directory = openAnswers(spool, executionId, true);
  const temporary = `/proc/self/fd/${directory}/.${randomUUID()}`;
  let file: number | undefined;
  let pending: number | undefined;
  try {
    mkdirSync(temporary, { mode: 0o750 });
    pending = openSync(
      temporary,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fchownSync(pending, spool.runnerUid, spool.agentGid);
    fchmodSync(pending, 0o750);
    file = openSync(
      `${temporary}/answer.json`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o640,
    );
    fchownSync(file, spool.runnerUid, spool.agentGid);
    fchmodSync(file, 0o640);
    writeFileSync(file, JSON.stringify(answer));
    fsyncSync(file);
    fsyncSync(pending);
    try {
      renameSync(temporary, `/proc/self/fd/${directory}/${answer.requestId}`);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      if (
        JSON.stringify(readRunnerAnswer(spool, executionId, answer.requestId)) !==
        JSON.stringify(answer)
      )
        throw new Error("Runner answer is immutable", { cause: error });
      journalCaught(
        error,
        "runner-answers.publishRunnerAnswer.renameSync",
        null,
        "path may already exist",
      );
    }
    fsyncSync(directory);
  } finally {
    if (file !== undefined) closeSync(file);
    if (pending !== undefined) closeSync(pending);
    rmSync(temporary, { recursive: true, force: true });
    closeSync(directory);
  }
  const parent = openSync(
    runnerJobDirectory(spool, executionId),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
