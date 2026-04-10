/**
 * packages/engine/src/field-association-annotations.test.ts
 *
 * Integration + unit tests for field-level entity/entity_connector annotations
 * (Pass 3 of _extractRefsFromData) and related config loading behavior.
 * Spec: specs/associations.md §9
 * Plans: PLAN_CONFIG_DECLARED_ASSOCIATIONS.md
 *
 * FAA1   entity on flat ChannelMember: plain-string FK extracted via Pass 3;
 *        shadow __assoc__ sentinel reflects the annotation.
 * FAA2   entity on array expansion ChannelMember: element FK extracted via Pass 3;
 *        child shadow __assoc__ sentinel set.
 * FAA4   Null / absent FK value → no association; record still processed.
 * FAA5   Pass 1 (explicit Ref in data) takes precedence; Pass 3 does not add duplicate.
 * FAA6   Pass 2 (connector schema entity) takes precedence; Pass 3 does not add duplicate.
 * FAA10  Two connectors with shared target name route FK end-to-end after identity resolved.
 * FAA11  Top-level associations key emits deprecation warning and is used as fallback.
 * FAA12  entity_connector without entity → config load error.
 */

import { describe, it, expect } from "bun:test";
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  InsertRecord,
  InsertResult,
  ReadBatch,
  UpdateRecord,
  UpdateResult,
} from "@opensync/sdk";
import { SyncEngine, openDb, type ResolvedConfig } from "./index.js";
import { loadConfig } from "./config/loader.js";
import type { ChannelMember, CompiledFieldAnnotation } from "./config/loader.js";
import type { Db } from "./db/index.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Db {
  return openDb(":memory:");
}

function makeTmpDir(): string {
  const dir = join(tmpdir(), `faa-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "mappings"), { recursive: true });
  return dir;
}

function writeConfig(dir: string, yaml: string, connectors: string[] = ["src", "tgt"]): void {
  const stub = `const c = { getEntities: () => [] }; export default c;\n`;
  for (const name of connectors) {
    writeFileSync(join(dir, `${name}-stub.ts`), stub);
  }
  const connObj = Object.fromEntries(connectors.map((name) => [name, { plugin: `./${name}-stub.ts`, config: {} }]));
  writeFileSync(join(dir, "opensync.json"), JSON.stringify({ connectors: connObj }));
  writeFileSync(join(dir, "mappings", "mappings.yaml"), yaml);
}

/** Single source entity that yields the given records. */
function makeSourceEntity(name: string, records: ReadBatch["records"]): EntityDefinition {
  return {
    name,
    async *read(): AsyncIterable<ReadBatch> {
      yield { records, since: "t1" };
    },
    async *insert(batch: AsyncIterable<InsertRecord>): AsyncIterable<InsertResult> {
      for await (const r of batch) yield { id: crypto.randomUUID(), data: r.data };
    },
    async *update(batch: AsyncIterable<UpdateRecord>): AsyncIterable<UpdateResult> {
      for await (const r of batch) yield { id: r.id };
    },
  };
}

/** Target entity that captures inserts. */
function makeTargetEntity(
  name: string,
  received: InsertRecord[],
): EntityDefinition {
  return {
    name,
    async *read(): AsyncIterable<ReadBatch> { yield { records: [], since: "t0" }; },
    async *insert(batch: AsyncIterable<InsertRecord>): AsyncIterable<InsertResult> {
      for await (const r of batch) {
        received.push(r);
        yield { id: crypto.randomUUID(), data: r.data };
      }
    },
    async *update(batch: AsyncIterable<UpdateRecord>): AsyncIterable<UpdateResult> {
      for await (const r of batch) yield { id: r.id };
    },
  };
}

/** Build a minimal two-connector ResolvedConfig. */
function makeConfig(
  srcEntities: EntityDefinition[],
  tgtEntities: EntityDefinition[],
  srcMember: ChannelMember,
  tgtMember: ChannelMember,
  channelId = "ch",
): ResolvedConfig {
  const src: Connector = {
    metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
    getEntities() { return srcEntities; },
  };
  const tgt: Connector = {
    metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
    getEntities() { return tgtEntities; },
  };
  return {
    connectors: [
      { id: "src", connector: src, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      { id: "tgt", connector: tgt, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
    ],
    channels: [{ id: channelId, members: [srcMember, tgtMember], identity: ["email"] }],
    conflict: {},
    readTimeoutMs: 10_000,
  };
}

// ─── FAA1: entity on flat member → Pass 3 stores __assoc__ sentinel ───────────

describe("FAA1: entity on flat ChannelMember — Pass 3 extracts plain-string FK", () => {
  it("shadow __assoc__ sentinel contains the FK association from Pass 3", async () => {
    const field: CompiledFieldAnnotation = {
      sourceField: "company_id",
      entity: "company",
    };

    const srcEntity = makeSourceEntity("contact", [
      { id: "c-1", data: { email: "alice@example.com", company_id: "cmp-42" } },
    ]);
    const tgtEntity = makeTargetEntity("contact", []);

    const srcMember: ChannelMember = {
      connectorId: "src",
      entity: "contact",
      inbound: [{ source: "email", target: "email" }],
      outbound: [{ source: "email", target: "email" }],
      assocMappings: [{ source: "company_id", target: "company_id" }],
      fieldAnnotations: [field],
    };
    const tgtMember: ChannelMember = {
      connectorId: "tgt",
      entity: "contact",
      inbound: [{ source: "email", target: "email" }],
      outbound: [{ source: "email", target: "email" }],
    };

    const db = makeDb();
    const engine = new SyncEngine(makeConfig([srcEntity], [tgtEntity], srcMember, tgtMember), db);
    await engine.ingest("ch", "src");

    // Source shadow should have __assoc__ sentinel
    const row = db
      .prepare<{ canonical_data: string }>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'src' AND entity_name = 'contact'",
      )
      .get();
    expect(row).toBeDefined();
    const fd = JSON.parse(row!.canonical_data) as Record<string, { val: unknown }>;
    const sentinel = fd["__assoc__"]?.val;
    expect(typeof sentinel).toBe("string");
    const assocs = JSON.parse(sentinel as string) as Array<{ predicate: string; targetEntity: string; targetId: string }>;
    expect(assocs).toHaveLength(1);
    expect(assocs[0]!.predicate).toBe("company_id");
    expect(assocs[0]!.targetEntity).toBe("company");
    expect(assocs[0]!.targetId).toBe("cmp-42");
  });
});

// ─── FAA2: entity on expansion ChannelMember ──────────────────────────────────

describe("FAA2: entity on array expansion ChannelMember — Pass 3 extracts element FK", () => {
  it("child shadow __assoc__ sentinel set when expansion member has fieldAnnotations", async () => {
    const annotation: CompiledFieldAnnotation = {
      sourceField: "productId",
      entity: "products",
    };

    const erpSrc: EntityDefinition = {
      name: "orders",
      async *read(): AsyncIterable<ReadBatch> {
        yield {
          records: [{ id: "ord-1", data: { lines: [{ lineNo: "L01", sku: "A", productId: "prod-777" }] } }],
          since: "t1",
        };
      },
    };
    const tgtEntity = makeTargetEntity("line_items", []);

    const erpConnector: Connector = {
      metadata: { name: "erp", version: "0.0.0", auth: { type: "none" } },
      getEntities() { return [erpSrc]; },
    };
    const tgtConnector: Connector = {
      metadata: { name: "crm", version: "0.0.0", auth: { type: "none" } },
      getEntities() { return [tgtEntity]; },
    };

    const config: ResolvedConfig = {
      connectors: [
        { id: "erp", connector: erpConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "crm", connector: tgtConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [{
        id: "order-lines",
        members: [
          {
            connectorId: "erp",
            entity: "order_lines",
            sourceEntity: "orders",
            arrayPath: "lines",
            elementKey: "lineNo",
            expansionChain: [{ arrayPath: "lines", elementKey: "lineNo" }],
            inbound: [
              { source: "lineNo", target: "lineNo" },
              { source: "sku", target: "sku" },
            ],
            outbound: [
              { source: "lineNo", target: "lineNo" },
              { source: "sku", target: "sku" },
            ],
            // fieldAnnotations on the expansion member
            assocMappings: [{ source: "productId", target: "productId" }],
            fieldAnnotations: [annotation],
          },
          {
            connectorId: "crm",
            entity: "line_items",
            inbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }],
            outbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }],
          },
        ],
        identity: ["lineNo"],
      }],
      conflict: {},
      readTimeoutMs: 10_000,
    };

    const db = makeDb();
    const engine = new SyncEngine(config, db);
    await engine.ingest("order-lines", "erp");

    const row = db
      .prepare<{ canonical_data: string }>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'erp' AND entity_name = 'order_lines'",
      )
      .get();
    expect(row).toBeDefined();
    const fd = JSON.parse(row!.canonical_data) as Record<string, { val: unknown }>;
    const sentinel = fd["__assoc__"]?.val;
    expect(typeof sentinel).toBe("string");
    const assocs = JSON.parse(sentinel as string) as Array<{ predicate: string; targetEntity: string; targetId: string }>;
    expect(assocs[0]!.predicate).toBe("productId");
    expect(assocs[0]!.targetEntity).toBe("products");
    expect(assocs[0]!.targetId).toBe("prod-777");
  });
});

// ─── FAA4: Null FK value — no association ─────────────────────────────────────

describe("FAA4: null FK value — no Association, record still processed", () => {
  it("shadow has no __assoc__ sentinel when the FK field is null", async () => {
    const field: CompiledFieldAnnotation = { sourceField: "company_id", entity: "company" };
    const srcEntity = makeSourceEntity("contact", [
      { id: "c-1", data: { email: "bob@example.com", company_id: null } },
    ]);
    const tgtEntity = makeTargetEntity("contact", []);

    const srcMember: ChannelMember = {
      connectorId: "src",
      entity: "contact",
      inbound: [{ source: "email", target: "email" }],
      outbound: [{ source: "email", target: "email" }],
      assocMappings: [{ source: "company_id", target: "company_id" }],
      fieldAnnotations: [field],
    };
    const tgtMember: ChannelMember = {
      connectorId: "tgt",
      entity: "contact",
      inbound: [{ source: "email", target: "email" }],
      outbound: [{ source: "email", target: "email" }],
    };

    const db = makeDb();
    const engine = new SyncEngine(makeConfig([srcEntity], [tgtEntity], srcMember, tgtMember), db);
    await engine.ingest("ch", "src");

    // Record was processed (canonical ID was created)
    const canonRows = db
      .prepare<{ n: number }>("SELECT COUNT(*) as n FROM identity_map WHERE connector_id = 'src'")
      .get();
    expect(canonRows!.n).toBeGreaterThan(0);

    // No __assoc__ sentinel in source shadow
    const row = db
      .prepare<{ canonical_data: string }>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'src' AND entity_name = 'contact'",
      )
      .get();
    const fd = JSON.parse(row!.canonical_data) as Record<string, unknown>;
    expect(fd["__assoc__"]).toBeUndefined();
  });
});

// ─── FAA5: Pass 1 (explicit Ref) wins over Pass 3 ────────────────────────────

describe("FAA5: Pass 1 (explicit Ref in data) takes precedence; Pass 3 does not add duplicate", () => {
  it("only one association produced when data has both a Ref and a fieldAnnotation for the same field", async () => {
    const field: CompiledFieldAnnotation = { sourceField: "company_id", entity: "company" };
    // Record contains an explicit Ref — Pass 1 handles it; Pass 3 should skip this field
    const srcEntity = makeSourceEntity("contact", [
      {
        id: "c-1",
        data: {
          email: "carol@example.com",
          // explicit Ref with @entity already set
          company_id: { '@id': 'cmp-100', '@entity': 'org' },
        },
      },
    ]);
    const tgtEntity = makeTargetEntity("contact", []);

    const srcMember: ChannelMember = {
      connectorId: "src",
      entity: "contact",
      inbound: [{ source: "email", target: "email" }],
      outbound: [{ source: "email", target: "email" }],
      assocMappings: [{ source: "company_id", target: "company_id" }],
      fieldAnnotations: [field],
    };
    const tgtMember: ChannelMember = {
      connectorId: "tgt",
      entity: "contact",
      inbound: [{ source: "email", target: "email" }],
      outbound: [{ source: "email", target: "email" }],
    };

    const db = makeDb();
    const engine = new SyncEngine(makeConfig([srcEntity], [tgtEntity], srcMember, tgtMember), db);
    await engine.ingest("ch", "src");

    const row = db
      .prepare<{ canonical_data: string }>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'src' AND entity_name = 'contact'",
      )
      .get();
    const fd = JSON.parse(row!.canonical_data) as Record<string, { val: unknown }>;
    const sentinel = fd["__assoc__"]?.val;
    expect(typeof sentinel).toBe("string");
    // Exactly one association (from Pass 1): targetEntity 'org' (from Ref @entity), not 'company' (from Pass 3)
    const assocs = JSON.parse(sentinel as string) as Array<{ predicate: string; targetEntity: string; targetId: string }>;
    expect(assocs).toHaveLength(1);
    expect(assocs[0]!.targetEntity).toBe("org"); // from Pass 1, not Pass 3's 'company'
    expect(assocs[0]!.targetId).toBe("cmp-100");
  });
});

// ─── FAA6: Pass 2 (connector schema) wins over Pass 3 ────────────────────────

describe("FAA6: Pass 2 (connector schema entity annotation) takes precedence over Pass 3", () => {
  it("Pass 2 entity wins when schema declares entity for the same field", async () => {
    // Source entity schema declares company_id.entity = 'org_from_schema'
    const srcEntityDef: EntityDefinition = {
      name: "contact",
      schema: { company_id: { entity: "org_from_schema" } },
      async *read(): AsyncIterable<ReadBatch> {
        yield {
          records: [{ id: "c-1", data: { email: "dave@example.com", company_id: "schema-org-1" } }],
          since: "t1",
        };
      },
    };
    const tgtEntity = makeTargetEntity("contact", []);
    const srcConnector: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities() { return [srcEntityDef]; },
    };
    const tgtConnector: Connector = {
      metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
      getEntities() { return [tgtEntity]; },
    };

    // fieldAnnotation also declares entity for company_id — should lose to Pass 2
    const field: CompiledFieldAnnotation = { sourceField: "company_id", entity: "override_from_yaml" };

    const srcMember: ChannelMember = {
      connectorId: "src",
      entity: "contact",
      inbound: [{ source: "email", target: "email" }],
      outbound: [{ source: "email", target: "email" }],
      assocMappings: [{ source: "company_id", target: "company_id" }],
      fieldAnnotations: [field],
    };
    const tgtMember: ChannelMember = {
      connectorId: "tgt",
      entity: "contact",
      inbound: [{ source: "email", target: "email" }],
      outbound: [{ source: "email", target: "email" }],
    };

    const config: ResolvedConfig = {
      connectors: [
        { id: "src", connector: srcConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "tgt", connector: tgtConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [{ id: "ch", members: [srcMember, tgtMember], identity: ["email"] }],
      conflict: {},
      readTimeoutMs: 10_000,
    };

    const db = makeDb();
    const engine = new SyncEngine(config, db);
    await engine.ingest("ch", "src");

    const row = db
      .prepare<{ canonical_data: string }>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'src' AND entity_name = 'contact'",
      )
      .get();
    const fd = JSON.parse(row!.canonical_data) as Record<string, { val: unknown }>;
    const assocs = JSON.parse(fd["__assoc__"]!.val as string) as Array<{ targetEntity: string }>;
    expect(assocs).toHaveLength(1);
    // Pass 2 fired first: entity from schema ('org_from_schema'), not from fieldAnnotation ('override_from_yaml')
    expect(assocs[0]!.targetEntity).toBe("org_from_schema");
  });
});

// ─── FAA10: assocMappings derived from field entries with entity ───────────────

describe("FAA10: assocMappings derived from field entries — end-to-end routing via shared target", () => {
  it("loadConfig derives assocMappings from fields with entity; member reports correct mappings", async () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, `
mappings:
  - connector: src
    channel: contacts
    entity: contacts
    fields:
      - source: email
        target: email
      - source: company_id
        target: companyId
        entity: company
  - connector: tgt
    channel: contacts
    entity: contacts
    fields:
      - source: email
        target: email
      - source: org_id
        target: companyId
        entity: organisation
`);
      const config = await loadConfig(dir);
      const ch = config.channels.find((c) => c.id === "contacts");
      const srcMember = ch?.members.find((m) => m.connectorId === "src");
      const tgtMember = ch?.members.find((m) => m.connectorId === "tgt");

      // assocMappings derived automatically from field entries with entity
      expect(srcMember?.assocMappings).toHaveLength(1);
      expect(srcMember?.assocMappings![0]!.source).toBe("company_id");
      expect(srcMember?.assocMappings![0]!.target).toBe("companyId");

      expect(tgtMember?.assocMappings).toHaveLength(1);
      expect(tgtMember?.assocMappings![0]!.source).toBe("org_id");
      expect(tgtMember?.assocMappings![0]!.target).toBe("companyId");

      // fieldAnnotations compiled from field entries
      expect(srcMember?.fieldAnnotations).toHaveLength(1);
      expect(srcMember?.fieldAnnotations![0]!.sourceField).toBe("company_id");
      expect(srcMember?.fieldAnnotations![0]!.entity).toBe("company");

      expect(tgtMember?.fieldAnnotations).toHaveLength(1);
      expect(tgtMember?.fieldAnnotations![0]!.sourceField).toBe("org_id");
      expect(tgtMember?.fieldAnnotations![0]!.entity).toBe("organisation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── FAA11: top-level associations key emits deprecation warning ──────────────

describe("FAA11: top-level associations key → deprecation warning at config load", () => {
  it("console.warn is called with a migration hint when associations is present", async () => {
    const dir = makeTmpDir();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); originalWarn(...args); };
    try {
      writeConfig(dir, `
mappings:
  - connector: src
    channel: contacts
    entity: contacts
    fields:
      - source: email
        target: email
    associations:
      - source: company_id
        target: companyId
  - connector: tgt
    channel: contacts
    entity: contacts
    fields:
      - source: email
        target: email
`);
      await loadConfig(dir);
      expect(warnings.some((w) => w.includes("associations") && w.includes("deprecated"))).toBe(true);
    } finally {
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── FAA12: entity_connector without entity → config load error ───────────────

describe("FAA12: entity_connector without entity → config load rejects", () => {
  it("Zod validation rejects a field that has entity_connector but no entity", async () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, `
mappings:
  - connector: src
    channel: contacts
    entity: contacts
    fields:
      - source: email
        target: email
      - source: company_id
        target: companyId
        entity_connector: erp
  - connector: tgt
    channel: contacts
    entity: contacts
    fields:
      - source: email
        target: email
`);
      await expect(loadConfig(dir)).rejects.toThrow(/entity_connector requires entity/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
