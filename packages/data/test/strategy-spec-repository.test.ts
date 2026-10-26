import { describe, expect, it } from "vitest";
import { ManualClock } from "@keel/core";
import { createSqliteDataStore } from "../src/index.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

describe("T6: Strategy Spec Repository & Monotonic Trial Accounting", () => {
  it("persists specs, links active spec by name, and increments research trials monotonically", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "keel-t6-spec-"));
    const dbPath = join(tempDir, "specs.sqlite");
    const clock = new ManualClock(1_700_000_000_000);

    let store = createSqliteDataStore({ dbPath, clock });
    try {
      expect(store.experimentRepo.getTrialCount()).toBe(0);

      const specHash1 = "a1b2c3d4e5f60000111122223333444455556666777788889999aaaabbbbcccc";
      const specJson1 = JSON.stringify({ name: "donchian-v1", version: 1, indicators: [] });

      // Save spec 1
      const saved1 = store.strategySpecRepo.saveSpec({
        specHash: specHash1,
        name: "donchian-v1",
        version: 1,
        specJson: specJson1,
        isSynthetic: false,
        createdAtMs: 1_700_000_000_000
      });

      expect(saved1.specHash).toBe(specHash1);
      expect(saved1.name).toBe("donchian-v1");
      expect(saved1.isSynthetic).toBe(false);

      // Verify trial count incremented to 1
      expect(store.experimentRepo.getTrialCount()).toBe(1);

      // Verify retrieval by hash and by name
      const byHash = store.strategySpecRepo.getSpecByHash(specHash1);
      expect(byHash).not.toBeNull();
      expect(byHash?.name).toBe("donchian-v1");

      const byName = store.strategySpecRepo.getSpecByName("donchian-v1");
      expect(byName).not.toBeNull();
      expect(byName?.specHash).toBe(specHash1);

      // Saving identical spec hash does not increment trial count
      store.strategySpecRepo.saveSpec({
        specHash: specHash1,
        name: "donchian-v1",
        version: 1,
        specJson: specJson1
      });
      expect(store.experimentRepo.getTrialCount()).toBe(1);

      // Save synthetic spec 2
      const specHash2 = "b2c3d4e5f60000111122223333444455556666777788889999aaaabbbbccccdd";
      const specJson2 = JSON.stringify({
        name: "synthetic-fixture-v1",
        version: 1,
        synthetic: true
      });
      const saved2 = store.strategySpecRepo.saveSpec({
        specHash: specHash2,
        name: "synthetic-fixture-v1",
        version: 1,
        specJson: specJson2,
        isSynthetic: true,
        createdAtMs: 1_700_000_100_000
      });
      expect(saved2.isSynthetic).toBe(true);
      expect(store.experimentRepo.getTrialCount()).toBe(2);

      // List specs
      const list = store.strategySpecRepo.listSpecs();
      expect(list).toHaveLength(2);
      expect(list[0]?.specHash).toBe(specHash2); // ordered by createdAtMs DESC

      // Update active spec for name
      const updatedActive = store.strategySpecRepo.setActiveSpec("donchian-v1", specHash2);
      expect(updatedActive.activeSpecHash).toBe(specHash2);
      const activeByName = store.strategySpecRepo.getSpecByName("donchian-v1");
      expect(activeByName?.specHash).toBe(specHash2);

      // Simulate restart
      store.close();
      store = createSqliteDataStore({ dbPath, clock });

      expect(store.experimentRepo.getTrialCount()).toBe(2);
      const reloaded = store.strategySpecRepo.getSpecByHash(specHash1);
      expect(reloaded?.name).toBe("donchian-v1");
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
