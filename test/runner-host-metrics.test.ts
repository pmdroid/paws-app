import { expect, test } from "bun:test";
import type { MetricLabels } from "../src/metrics";
import { createRunnerHostMetrics } from "../src/runner-host-metrics";
import { describePglite } from "./pglite-fixtures";
import { NOW, workspaceWithRunners } from "./runner-slot-fixture";

describePglite((connect) => {
  test("a runner's host metrics become runner.host gauges and bad reports set none", async () => {
    const { db, close } = await connect();
    try {
      const { pair } = await workspaceWithRunners(db);
      const runnerId = await pair("builder", 1, null);
      const gauges: [string, MetricLabels, number][] = [];
      const service = createRunnerHostMetrics({
        store: db,
        setGauge: (name, labels, value) => void gauges.push([name, labels, value]),
      });
      const post = (body: string, id = runnerId, method = "POST") =>
        service.fetch(
          new Request("https://runner.invalid/v1/host-metrics", {
            method,
            headers: { "content-type": "application/json" },
            ...(method === "POST" ? { body } : {}),
          }),
          id,
        );

      expect(
        await service.fetch(new Request("https://runner.invalid/v1/storage-report"), runnerId),
      ).toBeNull();
      expect((await post("", runnerId, "GET"))!.status).toBe(405);

      const full = {
        at: NOW,
        cpuCount: 8,
        cpuBusyRatio: 0.25,
        diskBusyRatio: 0.5,
        memoryPressureRatio: 0,
        memoryUsedBytes: 1_000,
        memoryTotalBytes: 2_000,
        rootUsedBytes: 3_000,
        rootSizeBytes: 2 ** 53,
        load1: 1.5,
        networkReceiveBytesPerSecond: 10,
        networkTransmitBytesPerSecond: 1e12,
      };
      const answer = await post(JSON.stringify(full));
      expect(answer!.status).toBe(200);
      expect(await answer!.json()).toEqual({ intervalMs: 30_000 });
      expect(gauges).toEqual([
        ["runner.host.cpu_count", { runner: "builder" }, 8],
        ["runner.host.cpu_busy_ratio", { runner: "builder" }, 0.25],
        ["runner.host.disk_busy_ratio", { runner: "builder" }, 0.5],
        ["runner.host.memory_pressure_ratio", { runner: "builder" }, 0],
        ["runner.host.memory_used_bytes", { runner: "builder" }, 1_000],
        ["runner.host.memory_total_bytes", { runner: "builder" }, 2_000],
        ["runner.host.root_used_bytes", { runner: "builder" }, 3_000],
        ["runner.host.root_size_bytes", { runner: "builder" }, 2 ** 53],
        ["runner.host.load1", { runner: "builder" }, 1.5],
        ["runner.host.network_receive_bytes_per_second", { runner: "builder" }, 10],
        ["runner.host.network_transmit_bytes_per_second", { runner: "builder" }, 1e12],
      ]);

      gauges.length = 0;
      const sparse = await post(JSON.stringify({ at: NOW, load1: 0.5 }));
      expect(await sparse!.json()).toEqual({ intervalMs: 30_000 });
      expect(gauges).toEqual([["runner.host.load1", { runner: "builder" }, 0.5]]);

      gauges.length = 0;
      const refused = [
        "{",
        JSON.stringify({ load1: 1 }),
        JSON.stringify({ at: NOW, cpuCount: 0 }),
        JSON.stringify({ at: NOW, cpuCount: 1025 }),
        JSON.stringify({ at: NOW, cpuBusyRatio: 1.01 }),
        JSON.stringify({ at: NOW, memoryUsedBytes: -1 }),
        JSON.stringify({ at: NOW, rootSizeBytes: 2 ** 53 + 2 }),
        JSON.stringify({ at: NOW, load1: 100_001 }),
        JSON.stringify({ at: NOW, networkReceiveBytesPerSecond: 1e13 }),
        JSON.stringify({ at: NOW, memoryUsedBytes: "1" }),
        JSON.stringify({ at: NOW, cpuCount: 2, swapUsedBytes: 1 }),
      ];
      for (const body of refused) expect([body, (await post(body))!.status]).toEqual([body, 400]);
      const large = JSON.stringify({ at: NOW, cpuCount: 2, pad: " ".repeat(16 * 1024) });
      expect((await post(large))!.status).toBe(413);
      expect((await post(JSON.stringify(full), "unknown-runner"))!.status).toBe(403);
      expect(gauges).toEqual([]);
    } finally {
      await close();
    }
  });
});
