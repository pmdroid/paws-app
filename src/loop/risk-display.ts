import type { Database } from "bun:sqlite";
import {
  watch,
  watchFile,
  unwatchFile,
  constants,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import type { MergeSettings } from "../config";
import {
  getCandidateRisk,
  latestCandidateRisk,
  getRiskAutoContext,
  saveRiskAutoContext,
  listRiskAutoContexts,
  type RiskAutoContext,
} from "../db";
import { journalCaught } from "../journal";
import { automaticRiskApproval } from "./automatic-risk-approval";
import { riskApprovals, riskGateOn } from "./risk-approval";

export type RiskDisplay = { head: string; detail: string };

/** Config is refreshed on writes and file changes, never on a status read. */
export class RiskDisplayReader {
  private readonly policyWatches = new Map<
    string,
    { head: string; key: string; stale: boolean; close: () => void }
  >();
  private closed = false;
  private configWatch: ReturnType<typeof watch> | undefined;
  private readonly heads = new Map<string, string>();
  private settings: { enabled: boolean; key: string } | null = null;
  private readonly changed = () => {
    if (this.closed) return;
    this.refreshSettings();
    this.watchConfig();
  };

  constructor(
    private readonly options: {
      db: Database;
      configPath: string;
      readSettings: () => Pick<MergeSettings, "autoApproveHighRisk" | "repositories">;
      publicUrl?: string | null;
      journal?: (line: string) => void;
    },
  ) {
    this.refreshSettings();
    try {
      watchFile(options.configPath, { persistent: false, interval: 1000 }, this.changed);
      this.watchConfig();
      for (const saved of listRiskAutoContexts(options.db))
        this.watchPolicy(saved.itemId, saved.head, saved.context);
    } catch (error) {
      this.caught(error, "watch", null);
    }
  }

  close(): void {
    this.closed = true;
    this.configWatch?.close();
    unwatchFile(this.options.configPath, this.changed);
    for (const policyWatch of this.policyWatches.values()) policyWatch.close();
    this.policyWatches.clear();
  }

  private watchConfig(): void {
    if (this.closed || this.configWatch) return;
    try {
      this.configWatch = watch(this.options.configPath, { persistent: false }, (event) => {
        if (event === "rename") {
          this.configWatch?.close();
          this.configWatch = undefined;
        }
        this.changed();
      });
      this.configWatch.on("error", (error) => {
        this.settings = null;
        this.configWatch?.close();
        this.configWatch = undefined;
        this.caught(error, "configWatch", null);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.settings = null;
        this.caught(error, "configWatch", null);
      }
    }
  }

  /** Captured during evaluation, never from read(). */
  observeFiles(paths: readonly string[]): NonNullable<RiskAutoContext["policyFiles"]> {
    return [...new Set(paths)].map((path) => ({ path, digest: this.fileDigest(path) }));
  }

  private fileDigest(path: string): string | null {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65_536) return "unreadable";
      const bytes = Buffer.alloc(65_537);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      return length > 65_536
        ? "unreadable"
        : createHash("sha256").update(bytes.subarray(0, length)).digest("hex");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (error) {
          this.caught(error, "closeFile", null);
        }
      }
    }
  }

  private watchPolicy(itemId: string, head: string, context: RiskAutoContext): void {
    const files = context.policyFiles ?? [];
    const key = JSON.stringify(files);
    const previous = this.policyWatches.get(itemId);
    if (previous?.head === head && previous.key === key) return;
    previous?.close();
    const eventWatches: Array<ReturnType<typeof watch>> = [];
    const state = {
      head,
      key,
      stale: false,
      watchFailed: false,
      close: () => {
        for (const file of files) unwatchFile(file.path, changed);
        for (const eventWatch of eventWatches) eventWatch.close();
      },
    };
    const changed = () => {
      state.stale =
        state.watchFailed ||
        files.some(
          (file) => file.digest === "unreadable" || this.fileDigest(file.path) !== file.digest,
        );
    };
    this.policyWatches.set(itemId, state);
    changed();
    try {
      for (const file of files)
        watchFile(file.path, { persistent: false, interval: 1000 }, changed);
    } catch (error) {
      state.watchFailed = true;
      state.stale = true;
      throw error;
    }
  }

  refreshSettings(): void {
    try {
      const settings = this.options.readSettings();
      const paths = Object.entries(settings.repositories)
        .map(([repo, value]) => [repo, [...(value.highRiskPaths ?? [])].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      this.settings = {
        enabled: settings.autoApproveHighRisk,
        key: JSON.stringify(paths),
      };
    } catch (error) {
      this.settings = null;
      this.caught(error, "settings", null);
    }
  }

  /** Only publication and merge evaluation call this, outside the read path. */
  inputs(): { autoApproveHighRisk: boolean; settingsKey?: string } {
    this.refreshSettings();
    return {
      autoApproveHighRisk: this.settings?.enabled ?? false,
      ...(this.settings ? { settingsKey: this.settings.key } : {}),
    };
  }

  /** Display persistence must never stop publication or a gate read. */
  remember(itemId: string, head: string, context: RiskAutoContext): void {
    this.heads.set(itemId, head);
    try {
      const risk = getCandidateRisk(this.options.db, itemId, head);
      if (risk?.tier === "normal") {
        this.policyWatches.get(itemId)?.close();
        this.policyWatches.delete(itemId);
        saveRiskAutoContext(this.options.db, itemId, head, null);
        return;
      }
      this.watchPolicy(itemId, head, context);
      saveRiskAutoContext(this.options.db, itemId, head, context);
    } catch (error) {
      this.caught(error, "remember", itemId);
    }
  }

  /** Reads only cached settings and stored rows; never grants or persists approval. */
  read(itemId: string, head?: string): RiskDisplay | null {
    try {
      const saved = getRiskAutoContext(this.options.db, itemId);
      const currentHead =
        head ??
        this.heads.get(itemId) ??
        saved?.head ??
        latestCandidateRisk(this.options.db, itemId)?.head;
      if (!currentHead) return null;
      const risk = getCandidateRisk(this.options.db, itemId, currentHead);
      if (risk?.tier === "normal") return null;
      if (!riskGateOn(this.options.publicUrl))
        return { head: currentHead, detail: "Risk gate is off: approval is not required" };
      const approvals = riskApprovals(this.options.db, itemId);
      if (approvals.some((ask) => ask.headCommit === currentHead))
        return { head: currentHead, detail: "Approved: a person approved this commit" };
      const context = saved?.head === currentHead ? saved.context : null;
      const watched = this.policyWatches.get(itemId);
      const validContext =
        this.settings !== null &&
        context?.settingsKey === this.settings.key &&
        (!context?.policyFiles?.length || (watched?.head === currentHead && !watched.stale));
      const approvedHead =
        validContext || context?.approvalKind === "same_patch" ? context?.approvedHead : null;
      if (approvedHead && approvals.some((ask) => ask.headCommit === approvedHead))
        return { head: currentHead, detail: "Approved: an earlier human approval carries over" };
      if (!risk || this.settings === null)
        return { head: currentHead, detail: "Manual approval required" };
      return {
        head: currentHead,
        detail: automaticRiskApproval(this.options.db, risk, {
          autoApproveHighRisk: this.settings.enabled,
          policyDigest: validContext ? context?.policyDigest : null,
          policyPaths: validContext ? context?.policyPaths : null,
        }).detail,
      };
    } catch (error) {
      this.caught(error, "read", itemId);
      return head ? { head, detail: "Manual approval required" } : null;
    }
  }

  private caught(error: unknown, operation: string, itemId: string | null): void {
    journalCaught(error, `risk-display.${operation}`, itemId, undefined, this.options.journal);
  }
}
