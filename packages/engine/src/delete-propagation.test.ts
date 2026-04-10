/**
 * packages/engine/src/delete-propagation.test.ts
 *
 * Tests for deletion primitives: record.deleted signal, propagateDeletes,
 * soft-delete field inspection, and full-snapshot absence detection.
 * Spec: specs/field-mapping.md §8, specs/sync-engine.md § Delete Propagation
 * Plans: PLAN_DELETE_PROPAGATION.md, PLAN_SOFT_DELETE_INSPECTION.md, PLAN_HARD_DELETE.md
 *
 * T-DEL-01  record.deleted=true marks deleted_at in shadow_state
 * T-DEL-02  Without propagateDeletes, no delete() call is made on any target
 * T-DEL-03  With propagateDeletes, delete() is called on each target with a mapped identity
 * T-DEL-04  Target without delete() method is skipped (no error)
 * T-DEL-05  Target with no identity mapping is skipped (no error)
 * T-DEL-06  SyncAction "delete" is returned in results
 * T-DEL-08  A subsequent upsert for same externalId resurrects the record (deleted_at → NULL)
 * SD1   deleted_flag: record with is_deleted=true treated as deleted
 * SD2   deleted_flag: record with is_deleted=false NOT treated as deleted
 * SD3   deleted_flag: record with is_deleted=null NOT treated as deleted
 * SD4   timestamp: record with deleted_at="2026-01-01" treated as deleted
 * SD5   timestamp: record with deleted_at=null NOT treated as deleted
 * SD6   active_flag: record with is_active=false treated as deleted
 * SD7   active_flag: record with is_active=null treated as deleted
 * SD8   active_flag: record with is_active=true NOT treated as deleted
 * SD9   expression: custom expression evaluated correctly
 * SD12  Connector-reported deleted:true unaffected when no soft_delete config present
 * SD13  Shadow row has deleted_at set after soft-delete field triggers deletion
 * SD14  Same record re-ingested without soft-delete marker → resurrection
 * HD1   full_snapshot: absent record has deleted_at set in shadow_state
 * HD2   full_snapshot: absent record excluded from resolution on next cycle
 * HD3   full_snapshot: forces since=undefined (no watermark passed to read)
 * HD4   Empty-batch safety: no deletions synthesized when returned set is empty and known rows exist
 * HD6   Resurrection: absent record re-appears → deleted_at cleared
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { SyncEngine } from "./engine.js";
import { openDb } from "./db/index.js";
import type {
  Connector,
  EntityDefinition,
  InsertResult,
  UpdateResult,
  DeleteResult,
  ReadRecord,
} from "@opensync/sdk";
import type { ResolvedConfig, ChannelMember } from "./config/loader.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb() { return openDb(":memory:"); }

/** Build a connector instance entry. */
function wired(id: string, connector: Connector): ResolvedConfig["connectors"][number] {
  return { id, connector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } };
}

/** Query all shadow rows for a connector+entity for inspection. */
function getShadowRows(db: ReturnType<typeof makeDb>, connectorId: string, entity: string) {
  return db.prepare<{ external_id: string; deleted_at: string | null }>(
    `SELECT external_id, deleted_at FROM shadow_state WHERE connector_id = ? AND entity_name = ?`,
  ).all(connectorId, entity);
}

// ─── Minimal in-memory connector factories ────────────────────────────────────

/** Connector with static records; can be told to yield deleted=true. */
function makeSourceConnector(
  id: string,
  records: ReadRecord[],
): Connector {
  return {
    metadata: { name: id, version: "0.0.0", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [{
        name: "items",
        async *read() {
          yield { records, since: "ts1" };
        },
        async *insert(recs): AsyncIterable<InsertResult> {
          for await (const r of recs) yield { id: `${id}-${r.data.name}`, data: r.data };
        },
        async *update(recs): AsyncIterable<UpdateResult> {
          for await (const r of recs) yield { id: r.id };
        },
      }];
    },
  };
}

/** Target connector that records delete calls. */
function makeTargetWithDelete(deletedIds: string[]): Connector {
  return {
    metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [{
        name: "items",
        // Seed record so discover() finds shadow_state.
        async *read() {
          yield { records: [{ id: "seed", data: { name: "_seed_" } }], since: "t0" };
        },
        async *insert(recs): AsyncIterable<InsertResult> {
          for await (const r of recs) yield { id: `tgt-${r.data.name}`, data: r.data };
        },
        async *update(recs): AsyncIterable<UpdateResult> {
          for await (const r of recs) yield { id: r.id };
        },
        async *delete(ids: AsyncIterable<string>): AsyncIterable<DeleteResult> {
          for await (const id of ids) {
            deletedIds.push(id);
            yield { id };
          }
        },
      }];
    },
  };
}

/** Target connector WITHOUT a delete method. */
function makeTargetWithoutDelete(): Connector {
  return {
    metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [{
        name: "items",
        // Seed record so discover() finds shadow_state.
        async *read() {
          yield { records: [{ id: "seed", data: { name: "_seed_" } }], since: "t0" };
        },
        async *insert(recs): AsyncIterable<InsertResult> {
          for await (const r of recs) yield { id: `tgt-${r.data.name}`, data: r.data };
        },
        async *update(recs): AsyncIterable<UpdateResult> {
          for await (const r of recs) yield { id: r.id };
        },
      }];
    },
  };
}

function makeConfig(
  srcConnector: Connector,
  tgtConnector: Connector,
  srcMember: Partial<ChannelMember> = {},
  propagateDeletes?: boolean,
): ResolvedConfig {
  return {
    connectors: [
      wired("src", srcConnector),
      wired("tgt", tgtConnector),
    ],
    channels: [
      {
        id: "ch",
        members: [
          { connectorId: "src", entity: "items", ...srcMember },
          { connectorId: "tgt", entity: "items" },
        ],
        identity: ["name"],
        propagateDeletes,
      },
    ],
    conflict: {},
    readTimeoutMs: 5_000,
  };
}

async function setupWithRecord(
  db: ReturnType<typeof makeDb>,
  engine: SyncEngine,
  name: string,
) {
  // First ingest: insert record so it has a canonical ID and written_state row.
  await engine.ingest("ch", "src", { collectOnly: true });
  await engine.ingest("ch", "tgt", { collectOnly: true });
  const report = await engine.discover("ch");
  await engine.onboard("ch", report);
  await engine.ingest("ch", "src");
}

// ═══ T-DEL-01: record.deleted=true sets deleted_at ════════════════════════════

describe("T-DEL-01: record.deleted=true marks deleted_at in shadow_state", () => {
  it("shadow row has deleted_at set after deletion signal", async () => {
    const db = makeDb();
    // Single-connector channel: just src. No discover/onboard needed.
    const singleConnectorConfig = (records: ReadRecord[]): ResolvedConfig => ({
      connectors: [wired("src", makeSourceConnector("src", records))],
      channels: [{
        id: "ch",
        members: [{ connectorId: "src", entity: "items" }],
        identity: ["name"],
      }],
      conflict: {},
      readTimeoutMs: 5_000,
    });

    // First cycle: ingest a live record
    await new SyncEngine(singleConnectorConfig([
      { id: "r1", data: { name: "Alice" } },
    ]), db).ingest("ch", "src");

    // Verify shadow row exists and is not deleted
    let rows = getShadowRows(db, "src", "items");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).toBeNull();

    // Second cycle: connector sends deleted=true
    const result = await new SyncEngine(singleConnectorConfig([
      { id: "r1", data: { name: "Alice" }, deleted: true },
    ]), db).ingest("ch", "src");

    // Shadow row must now have deleted_at set
    rows = getShadowRows(db, "src", "items");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();

    // Result includes a "delete" action
    expect(result.records.some((r) => r.action === "delete" && r.sourceId === "r1")).toBe(true);
  });
});

// ═══ T-DEL-02: No propagateDeletes → no delete() call ════════════════════════

describe("T-DEL-02: without propagateDeletes, no delete() called on targets", () => {
  it("delete() is never called when propagateDeletes is not set", async () => {
    const db = makeDb();
    const deletedIds: string[] = [];
    const tgt = makeTargetWithDelete(deletedIds);
    const liveSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Bob" } }]);
    const engine = new SyncEngine(makeConfig(liveSrc, tgt), db);

    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    await engine.ingest("ch", "src");

    // Now delete (no propagateDeletes)
    const deletingSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Bob" }, deleted: true }]);
    const engine2 = new SyncEngine(makeConfig(deletingSrc, tgt, {}, undefined), db);
    await engine2.ingest("ch", "src");

    expect(deletedIds).toHaveLength(0);
  });
});

// ═══ T-DEL-03: propagateDeletes=true → delete() called on target ═════════════

describe("T-DEL-03: with propagateDeletes, delete() called on each target with mapped identity", () => {
  it("delete() called with target externalId when propagateDeletes=true", async () => {
    const db = makeDb();
    const deletedIds: string[] = [];
    const tgt = makeTargetWithDelete(deletedIds);
    const liveSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Carol" } }]);
    const engine = new SyncEngine(makeConfig(liveSrc, tgt, {}, false), db);

    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    await engine.ingest("ch", "src");

    // Capture the target's external ID that was inserted (Carol's row, not the seed)
    const tgtShadow = db.prepare<{ external_id: string }>(
      `SELECT external_id FROM shadow_state WHERE connector_id = 'tgt' AND entity_name = 'items' AND external_id != 'seed'`,
    ).get();
    expect(tgtShadow).toBeDefined();
    const tgtId = tgtShadow!.external_id;

    // Now delete with propagateDeletes
    const deletingSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Carol" }, deleted: true }]);
    const engine2 = new SyncEngine(makeConfig(deletingSrc, tgt, {}, true), db);
    const result = await engine2.ingest("ch", "src");

    // delete() should have been called with the target's external ID
    expect(deletedIds).toContain(tgtId);

    // Result includes a "delete" action for the target
    const deleteResults = result.records.filter((r) => r.action === "delete" && r.targetConnectorId === "tgt");
    expect(deleteResults.length).toBeGreaterThan(0);
    expect(deleteResults[0]!.targetId).toBe(tgtId);
  });
});

// ═══ T-DEL-04: Target without delete() method is skipped ═════════════════════

describe("T-DEL-04: target without delete() method is skipped gracefully", () => {
  it("no error when target has no delete(), deletion still marks source shadow", async () => {
    const db = makeDb();
    const tgt = makeTargetWithoutDelete();
    const liveSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Dave" } }]);
    const engine = new SyncEngine(makeConfig(liveSrc, tgt, {}, false), db);

    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    await engine.ingest("ch", "src");

    // Delete with propagateDeletes — target has no delete()
    const deletingSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Dave" }, deleted: true }]);
    const engine2 = new SyncEngine(makeConfig(deletingSrc, tgt, {}, true), db);
    const result = await engine2.ingest("ch", "src");

    // No error actions emitted; source shadow is marked deleted
    const errors = result.records.filter((r) => r.action === "error");
    expect(errors).toHaveLength(0);

    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

// ═══ T-DEL-06: SyncAction "delete" in results ════════════════════════════════

describe("T-DEL-06: SyncAction 'delete' returned in ingest results", () => {
  it("results contain action='delete' for the deleted source record", async () => {
    const db = makeDb();
    const tgt = makeTargetWithoutDelete();
    const liveSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Eve" } }]);
    const engine = new SyncEngine(makeConfig(liveSrc, tgt), db);

    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    await engine.ingest("ch", "src");

    const deletingSrc = makeSourceConnector("src", [{ id: "r1", data: {}, deleted: true }]);
    const engine2 = new SyncEngine(makeConfig(deletingSrc, tgt), db);
    const result = await engine2.ingest("ch", "src");

    const del = result.records.find((r) => r.action === "delete" && r.targetConnectorId === "");
    expect(del).toBeDefined();
    expect(del!.sourceId).toBe("r1");
  });
});

// ═══ T-DEL-08: Resurrection ═══════════════════════════════════════════════════

describe("T-DEL-08: re-ingest of same externalId after deletion resurrects the record", () => {
  it("deleted_at cleared when non-deleted record arrives for same externalId", async () => {
    const db = makeDb();
    const tgt = makeTargetWithoutDelete();
    const liveSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Frank" } }]);
    const engine = new SyncEngine(makeConfig(liveSrc, tgt), db);

    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    await engine.ingest("ch", "src");

    // Delete
    const delSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Frank" }, deleted: true }]);
    const engine2 = new SyncEngine(makeConfig(delSrc, tgt), db);
    await engine2.ingest("ch", "src");

    let rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();

    // Resurrect
    const resSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Frank Resurrected" } }]);
    const engine3 = new SyncEngine(makeConfig(resSrc, tgt), db);
    await engine3.ingest("ch", "src");

    rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

// ═══ SD1–SD8: Soft-delete field inspection ════════════════════════════════════

function makeSoftDeleteConfig(
  records: ReadRecord[],
  softDeletePredicate: (r: Record<string, unknown>) => boolean,
  propagateDeletes?: boolean,
): ResolvedConfig {
  const src = makeSourceConnector("src", records);
  const tgt = makeTargetWithoutDelete();
  return {
    connectors: [wired("src", src), wired("tgt", tgt)],
    channels: [{
      id: "ch",
      members: [
        { connectorId: "src", entity: "items", softDeletePredicate },
        { connectorId: "tgt", entity: "items" },
      ],
      identity: ["name"],
      propagateDeletes,
    }],
    conflict: {},
    readTimeoutMs: 5_000,
  };
}

async function ingestTwice(config1: ResolvedConfig, config2: ResolvedConfig) {
  const db = makeDb();
  const e1 = new SyncEngine(config1, db);
  await e1.ingest("ch", "src", { collectOnly: true });
  await e1.ingest("ch", "tgt", { collectOnly: true });
  const report = await e1.discover("ch");
  await e1.onboard("ch", report);
  await e1.ingest("ch", "src");

  const e2 = new SyncEngine(config2, db);
  const result = await e2.ingest("ch", "src");
  return { db, result };
}

describe("SD1: deleted_flag — is_deleted=true treated as deleted", () => {
  it("soft-delete predicate for deleted_flag strategy fires for truthy value", async () => {
    const live = [{ id: "r1", data: { name: "Alice", is_deleted: false } }];
    const del = [{ id: "r1", data: { name: "Alice", is_deleted: true } }];
    const pred = (r: Record<string, unknown>) => r["is_deleted"] !== false && r["is_deleted"] != null;

    const { db } = await ingestTwice(
      makeSoftDeleteConfig(live, pred),
      makeSoftDeleteConfig(del, pred),
    );

    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

describe("SD2: deleted_flag — is_deleted=false NOT treated as deleted", () => {
  it("soft-delete predicate for deleted_flag strategy does not fire for false value", async () => {
    const records = [{ id: "r1", data: { name: "Bob", is_deleted: false } }];
    const pred = (r: Record<string, unknown>) => r["is_deleted"] !== false && r["is_deleted"] != null;
    const config = makeSoftDeleteConfig(records, pred);

    const db = makeDb();
    const engine = new SyncEngine(config, db);
    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    const result = await engine.ingest("ch", "src");

    expect(result.records.some((r) => r.action === "delete")).toBe(false);
    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

describe("SD3: deleted_flag — is_deleted=null NOT treated as deleted", () => {
  it("null value for deleted_flag is not deletion", async () => {
    const records = [{ id: "r1", data: { name: "Carol", is_deleted: null } }];
    const pred = (r: Record<string, unknown>) => r["is_deleted"] !== false && r["is_deleted"] != null;
    const config = makeSoftDeleteConfig(records, pred);

    const db = makeDb();
    const engine = new SyncEngine(config, db);
    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    await engine.discover("ch");
    // No onboard needed; just check deletion is not triggered
    const result = await engine.ingest("ch", "src");

    expect(result.records.some((r) => r.action === "delete")).toBe(false);
  });
});

describe("SD4: timestamp — deleted_at set treated as deleted", () => {
  it("non-null deleted_at column fires the timestamp strategy", async () => {
    const live = [{ id: "r1", data: { name: "Dave", deleted_at: null } }];
    const del = [{ id: "r1", data: { name: "Dave", deleted_at: "2026-01-01T00:00:00Z" } }];
    const pred = (r: Record<string, unknown>) => r["deleted_at"] != null;

    const { db } = await ingestTwice(
      makeSoftDeleteConfig(live, pred),
      makeSoftDeleteConfig(del, pred),
    );

    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

describe("SD5: timestamp — deleted_at=null NOT treated as deleted", () => {
  it("null deleted_at column does not fire timestamp strategy", async () => {
    const records = [{ id: "r1", data: { name: "Eve", deleted_at: null } }];
    const pred = (r: Record<string, unknown>) => r["deleted_at"] != null;
    const config = makeSoftDeleteConfig(records, pred);

    const db = makeDb();
    const engine = new SyncEngine(config, db);
    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    await engine.discover("ch");
    const result = await engine.ingest("ch", "src");

    expect(result.records.some((r) => r.action === "delete")).toBe(false);
  });
});

describe("SD6: active_flag — is_active=false treated as deleted", () => {
  it("inactive record triggers active_flag deletion", async () => {
    const live = [{ id: "r1", data: { name: "Frank", is_active: true } }];
    const del = [{ id: "r1", data: { name: "Frank", is_active: false } }];
    const pred = (r: Record<string, unknown>) => r["is_active"] !== true;

    const { db } = await ingestTwice(
      makeSoftDeleteConfig(live, pred),
      makeSoftDeleteConfig(del, pred),
    );

    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

describe("SD7: active_flag — is_active=null treated as deleted", () => {
  it("null is_active triggers active_flag deletion", async () => {
    const live = [{ id: "r1", data: { name: "Grace", is_active: true } }];
    const del = [{ id: "r1", data: { name: "Grace", is_active: null } }];
    const pred = (r: Record<string, unknown>) => r["is_active"] !== true;

    const { db } = await ingestTwice(
      makeSoftDeleteConfig(live, pred),
      makeSoftDeleteConfig(del, pred),
    );

    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

describe("SD8: active_flag — is_active=true NOT treated as deleted", () => {
  it("active record does not trigger active_flag deletion", async () => {
    const records = [{ id: "r1", data: { name: "Heidi", is_active: true } }];
    const pred = (r: Record<string, unknown>) => r["is_active"] !== true;
    const config = makeSoftDeleteConfig(records, pred);

    const db = makeDb();
    const engine = new SyncEngine(config, db);
    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    await engine.discover("ch");
    const result = await engine.ingest("ch", "src");

    expect(result.records.some((r) => r.action === "delete")).toBe(false);
  });
});

describe("SD9: expression strategy — custom expression evaluated correctly", () => {
  it("expression strategy with compound condition fires correctly ", async () => {
    const live = [{ id: "r1", data: { name: "Ivan", archived: false, vip: false } }];
    // archived AND NOT vip → deleted
    const del = [{ id: "r1", data: { name: "Ivan", archived: true, vip: false } }];
    const pred = (r: Record<string, unknown>) => Boolean(r["archived"] && !r["vip"]);

    const { db } = await ingestTwice(
      makeSoftDeleteConfig(live, pred),
      makeSoftDeleteConfig(del, pred),
    );

    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

describe("SD12: connector-reported deleted:true unaffected when no soft_delete config present", () => {
  it("connector deleted=true still triggers deletion even without soft_delete predicate", async () => {
    const db = makeDb();
    const tgt = makeTargetWithoutDelete();
    const liveSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Jan" } }]);
    const engine = new SyncEngine(makeConfig(liveSrc, tgt), db);

    await engine.ingest("ch", "src", { collectOnly: true });
    await engine.ingest("ch", "tgt", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    await engine.ingest("ch", "src");

    const delSrc = makeSourceConnector("src", [{ id: "r1", data: { name: "Jan" }, deleted: true }]);
    const engine2 = new SyncEngine(makeConfig(delSrc, tgt), db);
    const result = await engine2.ingest("ch", "src");

    expect(result.records.some((r) => r.action === "delete")).toBe(true);
  });
});

describe("SD13: shadow row has deleted_at set after soft-delete field triggers deletion", () => {
  it("soft-delete field inspection sets deleted_at on shadow row", async () => {
    const live = [{ id: "r1", data: { name: "Kate", is_deleted: false } }];
    const del = [{ id: "r1", data: { name: "Kate", is_deleted: true } }];
    const pred = (r: Record<string, unknown>) => r["is_deleted"] !== false && r["is_deleted"] != null;

    const { db } = await ingestTwice(
      makeSoftDeleteConfig(live, pred),
      makeSoftDeleteConfig(del, pred),
    );

    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

describe("SD14: re-ingested record without soft-delete marker → resurrection", () => {
  it("deleted_at cleared when record next comes in without deletion marker", async () => {
    const live = [{ id: "r1", data: { name: "Leo", is_deleted: false } }];
    const del = [{ id: "r1", data: { name: "Leo", is_deleted: true } }];
    const res = [{ id: "r1", data: { name: "Leo", is_deleted: false } }];
    const pred = (r: Record<string, unknown>) => r["is_deleted"] !== false && r["is_deleted"] != null;

    const db = makeDb();
    const e1 = new SyncEngine(makeSoftDeleteConfig(live, pred), db);
    await e1.ingest("ch", "src", { collectOnly: true });
    await e1.ingest("ch", "tgt", { collectOnly: true });
    const report = await e1.discover("ch");
    await e1.onboard("ch", report);
    await e1.ingest("ch", "src");

    await new SyncEngine(makeSoftDeleteConfig(del, pred), db).ingest("ch", "src");
    let rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).not.toBeNull();

    await new SyncEngine(makeSoftDeleteConfig(res, pred), db).ingest("ch", "src");
    rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

// ═══ HD1: full_snapshot — absent record sets deleted_at ══════════════════════

describe("HD1: full_snapshot — absent record has deleted_at set in shadow_state", () => {
  it("absent record from full-snapshot batch is tombstoned", async () => {
    const db = makeDb();
    const tgt = makeTargetWithoutDelete();

    // First cycle: ingest r1 and r2
    const src1: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "items",
          async *read() {
            yield { records: [
              { id: "r1", data: { name: "Alice" } },
              { id: "r2", data: { name: "Bob" } },
            ], since: "ts1" };
          },
          async *insert(recs): AsyncIterable<InsertResult> {
            for await (const r of recs) yield { id: `t-${r.data.name}`, data: r.data };
          },
          async *update(recs): AsyncIterable<UpdateResult> {
            for await (const r of recs) yield { id: r.id };
          },
        }];
      },
    };

    const e1 = new SyncEngine({
      connectors: [wired("src", src1), wired("tgt", tgt)],
      channels: [{
        id: "ch",
        members: [
          { connectorId: "src", entity: "items", fullSnapshot: true },
          { connectorId: "tgt", entity: "items" },
        ],
        identity: ["name"],
      }],
      conflict: {},
      readTimeoutMs: 5_000,
    }, db);

    await e1.ingest("ch", "src", { collectOnly: true });
    await e1.ingest("ch", "tgt", { collectOnly: true });
    const report1 = await e1.discover("ch");
    await e1.onboard("ch", report1);
    await e1.ingest("ch", "src");

    // Second cycle: only r1 returned (r2 is absent)
    const src2: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "items",
          async *read() {
            yield { records: [{ id: "r1", data: { name: "Alice" } }], since: "ts2" };
          },
          async *insert(recs): AsyncIterable<InsertResult> {
            for await (const r of recs) yield { id: `t-${r.data.name}`, data: r.data };
          },
          async *update(recs): AsyncIterable<UpdateResult> {
            for await (const r of recs) yield { id: r.id };
          },
        }];
      },
    };

    const e2 = new SyncEngine({
      connectors: [wired("src", src2), wired("tgt", tgt)],
      channels: [{
        id: "ch",
        members: [
          { connectorId: "src", entity: "items", fullSnapshot: true },
          { connectorId: "tgt", entity: "items" },
        ],
        identity: ["name"],
      }],
      conflict: {},
      readTimeoutMs: 5_000,
    }, db);

    const result = await e2.ingest("ch", "src");

    // r2 should be marked deleted
    const rows = getShadowRows(db, "src", "items");
    const r2Row = rows.find((r) => r.external_id === "r2");
    expect(r2Row!.deleted_at).not.toBeNull();

    // A "delete" result should be emitted for r2
    expect(result.records.some((r) => r.action === "delete" && r.sourceId === "r2")).toBe(true);
  });
});

// ═══ HD3: full_snapshot forces since=undefined ═══════════════════════════════

describe("HD3: full_snapshot forces since=undefined (no watermark passed)", () => {
  it("read() called without a 'since' parameter for full-snapshot members", async () => {
    const receivedSince: Array<string | undefined> = [];
    const db = makeDb();

    const src: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "items",
          async *read(ctx, since) {
            receivedSince.push(since);
            yield { records: [{ id: "r1", data: { name: "Alice" } }], since: "ts2" };
          },
          async *insert(recs): AsyncIterable<InsertResult> {
            for await (const r of recs) yield { id: `t-${r.data.name}`, data: r.data };
          },
          async *update(recs): AsyncIterable<UpdateResult> {
            for await (const r of recs) yield { id: r.id };
          },
        }];
      },
    };

    const tgt = makeTargetWithoutDelete();
    const config: ResolvedConfig = {
      connectors: [wired("src", src), wired("tgt", tgt)],
      channels: [{
        id: "ch",
        members: [
          { connectorId: "src", entity: "items", fullSnapshot: true },
          { connectorId: "tgt", entity: "items" },
        ],
        identity: ["name"],
      }],
      conflict: {},
      readTimeoutMs: 5_000,
    };

    // First ingest stores a watermark
    const e1 = new SyncEngine(config, db);
    await e1.ingest("ch", "src");
    // Watermark "ts2" should be stored

    receivedSince.length = 0; // reset

    // Second ingest: fullSnapshot should ignore the stored watermark
    const e2 = new SyncEngine(config, db);
    await e2.ingest("ch", "src");

    // since should always be undefined for full-snapshot members
    expect(receivedSince[0]).toBeUndefined();
  });
});

// ═══ HD4: Empty-batch safety ══════════════════════════════════════════════════

describe("HD4: empty-batch safety — no deletions synthesized when returned set is empty", () => {
  it("guards against false positives from empty reads", async () => {
    const db = makeDb();
    const tgt = makeTargetWithoutDelete();

    // First cycle: ingest record
    const src1: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "items",
          async *read() {
            yield { records: [{ id: "r1", data: { name: "Alice" } }], since: "ts1" };
          },
          async *insert(recs): AsyncIterable<InsertResult> {
            for await (const r of recs) yield { id: `t-${r.data.name}`, data: r.data };
          },
          async *update(recs): AsyncIterable<UpdateResult> {
            for await (const r of recs) yield { id: r.id };
          },
        }];
      },
    };

    const cfg = (connector: Connector) => ({
      connectors: [wired("src", connector), wired("tgt", tgt)],
      channels: [{
        id: "ch",
        members: [
          { connectorId: "src", entity: "items", fullSnapshot: true },
          { connectorId: "tgt", entity: "items" },
        ],
        identity: ["name"],
      }],
      conflict: {},
      readTimeoutMs: 5_000,
    } satisfies ResolvedConfig);

    const e1 = new SyncEngine(cfg(src1), db);
    await e1.ingest("ch", "src", { collectOnly: true });
    await e1.ingest("ch", "tgt", { collectOnly: true });
    const report = await e1.discover("ch");
    await e1.onboard("ch", report);
    await e1.ingest("ch", "src");

    // Second cycle: connector returns EMPTY set (connector error scenario)
    const emptyConnector: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "items",
          async *read() {
            yield { records: [], since: "ts2" }; // empty batch!
          },
          async *insert(recs): AsyncIterable<InsertResult> {
            for await (const r of recs) yield { id: `e-${r.data.name}`, data: r.data };
          },
          async *update(recs): AsyncIterable<UpdateResult> {
            for await (const r of recs) yield { id: r.id };
          },
        }];
      },
    };

    const e2 = new SyncEngine(cfg(emptyConnector), db);
    const result = await e2.ingest("ch", "src");

    // NO deletion should be synthesized from the empty batch
    expect(result.records.some((r) => r.action === "delete")).toBe(false);

    // r1 shadow still alive (not tombstoned)
    const rows = getShadowRows(db, "src", "items");
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

// ═══ HD6: Resurrection after absence ═════════════════════════════════════════

describe("HD6: resurrection — absent record re-appears in next batch", () => {
  it("deleted_at cleared when previously-absent record returns", async () => {
    const db = makeDb();
    const tgt = makeTargetWithoutDelete();

    const makeFullSnapshotConnector = (records: ReadRecord[]): Connector => ({
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "items",
          async *read() { yield { records, since: "ts1" }; },
          async *insert(recs): AsyncIterable<InsertResult> {
            for await (const r of recs) yield { id: `t-${r.data.name}`, data: r.data };
          },
          async *update(recs): AsyncIterable<UpdateResult> {
            for await (const r of recs) yield { id: r.id };
          },
        }];
      },
    });

    const cfg = (connector: Connector) => ({
      connectors: [wired("src", connector), wired("tgt", tgt)],
      channels: [{
        id: "ch",
        members: [
          { connectorId: "src", entity: "items", fullSnapshot: true },
          { connectorId: "tgt", entity: "items" },
        ],
        identity: ["name"],
      }],
      conflict: {},
      readTimeoutMs: 5_000,
    } satisfies ResolvedConfig);

    // Cycle 1: r1 and r2
    const e1 = new SyncEngine(cfg(makeFullSnapshotConnector([
      { id: "r1", data: { name: "Alice" } },
      { id: "r2", data: { name: "Bob" } },
    ])), db);
    await e1.ingest("ch", "src", { collectOnly: true });
    await e1.ingest("ch", "tgt", { collectOnly: true });
    await e1.onboard("ch", await e1.discover("ch"));
    await e1.ingest("ch", "src");

    // Cycle 2: only r1 → r2 tombstoned
    await new SyncEngine(cfg(makeFullSnapshotConnector([
      { id: "r1", data: { name: "Alice" } },
    ])), db).ingest("ch", "src");

    let rows = getShadowRows(db, "src", "items");
    expect(rows.find((r) => r.external_id === "r2")!.deleted_at).not.toBeNull();

    // Cycle 3: both return again → r2 resurrected
    await new SyncEngine(cfg(makeFullSnapshotConnector([
      { id: "r1", data: { name: "Alice" } },
      { id: "r2", data: { name: "Bob" } },
    ])), db).ingest("ch", "src");

    rows = getShadowRows(db, "src", "items");
    expect(rows.find((r) => r.external_id === "r2")!.deleted_at).toBeNull();
  });
});
