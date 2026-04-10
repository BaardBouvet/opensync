# Changelog

All notable changes to OpenSync are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

During development: add bullets under `[Unreleased]` using `### Added` / `### Fixed` / `### Changed`.
At release: distill into a short intro paragraph + bold-label bullets, remove the working notes. See `[0.1.0]`.

---

## [Unreleased]

### Added
- **Sync Engine — atomic array `sort_elements`** — new `sort_elements: true` field-mapping key sorts array elements before the noop diff check so that element reordering alone does not trigger a re-sync. Equivalent connector-schema flag: `{ type: "array", unordered: true }` on `FieldType`.
- **Sync Engine — atomic array `element_fields`** — new self-referential `element_fields` field-mapping key renames fields within each element of an array field (both inbound and outbound) without expanding the array into child entity rows. Supports nested `element_fields` for deeply nested arrays.
- **Sync Engine — `normalizeForDiff`** — schema-guided recursive normalizer: descends the `FieldType` tree sorting every `unordered: true` array at any nesting depth; used by `buildNormalizers` and reachable via the entity schema path. Tests AA1–AA5, AT1–AT5.

### Added
- **Sync Engine — delete propagation** — `propagateDeletes: true` on a channel config now fans out `entity.delete()` calls to all target connectors when a source record is deleted. Tombstones shadow rows with `deleted_at` and records a `"delete"` `SyncAction`.
- **Sync Engine — soft-delete field inspection** — new `soft_delete:` mapping config key with four strategies (`deleted_flag`, `timestamp`, `active_flag`, `expression`). Predicate compiled at config-load time; evaluated before echo detection so the connector need not translate the signal.
- **Sync Engine — full-snapshot hard delete** — new `full_snapshot: true` mapping config key. Engine always reads without a watermark and synthesises `deleted: true` records for any entity absent from the current snapshot. Safety guard trips if > 50% of known entities are absent.
- **Sync Engine — array element hard delete** — after processing each array expansion batch, the engine detects missing child elements, tombstones their shadow rows, and triggers an empty-patch collapse-rebuild that strips the deleted element from the target array.
- **Sync Engine — scalar array collapse** — `_scalarCollapseRebuild` rebuilds a bare scalar array (e.g. `["vip", "churned"]`) from canonical children at collapse time. Element absence triggers cascade shadow deletion to all member connectors so deleted elements are reliably excluded. `_value` is preserved through the expansion pipeline (`scalar: true` children are exempt from the `_`-prefix strip). Tests SC1–SC8.
- **Sync Engine — route-combined** — validated that a filtered mapping entry (CRM, `filter: record.type === 'customer'`) and an unfiltered entry (ERP) correctly merge into the same canonical entity via identity linking. Shadow rows are independent; filter clearance from one source does not affect the other; ingest order is invariant; `reverse_filter` suppresses write-back without cross-source impact. Tests RC1–RC6.
- **Sync Engine — element-set resolution** — ES resolution pre-step in `_applyCollapseBatch` groups patches from all contributing sources by leaf `elementKey` and applies `connectorPriorities`, per-field `last_modified` timestamps, and `fieldMasters` to select the winning value per field. `fieldMasters` filtering applies even to single-patch batches. Tests ES1–ES7.

### Changed
- **OSI-mapping primitive coverage** — GAP report and `specs/field-mapping.md` coverage table corrected and updated: References & FKs (3 items promoted ✅), routing (discriminator ✅, route-combined/element-set promoted 🔶), sources/primary_key metadata (✅), scalar array row corrected to 🔶 (reverse/collapse not yet implemented). Totals now **33✅ 8🔶 9❌**.
- **Sync Engine — `source_path` extraction** — new `source_path` field-mapping key extracts values from nested JSON paths in source records (`address.street`, `lines[0].sku`). Forward pass extraction + reverse pass nested-path reconstruction; shared-prefix entries merged on reverse; array-index restricted to `reverse_only` fields. Valid inside `element_fields`. Tests SP1–SP10.
- **Sync Engine — embedded objects** — `parent:` without `array_path` splits one source row into multiple canonical entities. Child external ID derived as `<parentId>#<childEntity>`; reverse pass merges child outbound fields into the parent connector's `UpdateRecord`; parent-delete cascades to child shadow tombstones. Tests EO1–EO7.

---

## [0.3.0] — 2026-04-10

Cluster management, identity polish, and a significantly richer lineage diagram. The engine gains two cluster-splitting primitives — a whole-cluster split and a single-record detach with anti-affinity — so merges can be reversed precisely. The identity config is simplified to a single polymorphic key and the implicit LWW conflict default is made explicit. The playground's lineage diagram now surfaces typed field descriptors at every level, including expandable array sub-field schemas, and array-source entity columns correctly resolve their element schema. The Connector SDK gains `FieldDescriptor.example` and elevates object `properties` from bare type scalars to full descriptors.

### Added
- **Sync Engine — `splitCluster()`** — breaks a linked cluster apart; each connector record gets a fresh `canonical_id`. Inverse of the `onboard()` merge.
- **Sync Engine — `splitCanonical()`** — detaches a single record from a cluster without disturbing siblings; writes `no_link` for all siblings. Scalpel vs `splitCluster()`'s sledgehammer.
- **Sync Engine — anti-affinity (`no_link`)** — new `no_link` table prevents records that were deliberately split from being re-merged on the next sync tick. `SyncEngine.removeNoLink()` lifts the block.
- **Browser Playground — cluster split and break buttons** — ✂ floats on the cluster legend to split the whole group; ✂ floats on each linked card to detach that record. `SPLIT` and `BREAK` events appear in the dev-tools log.
- **Browser Playground — no-link badge + popover** — linked-cluster cards show a ⛓ `no-link (N)` badge when anti-affinity entries exist. Clicking it opens an inline popover listing partners with individual ✕ remove buttons.
- **Browser Playground — `no_link` dev-tools tab** — sixth panel tab shows all `no_link` rows for audit.
- **Browser Playground — version badge and update notification** — topbar shows the current version; a dismissible notice appears when a newer GitHub release is available.
- **Browser Playground — URL history** — active scenario and tab are encoded in `#scenario=<key>&tab=<id>`; scenario switches push a history entry; shareable links work.
- **Browser Playground — lineage unassigned pool** — entities not covered by any channel appear in an `unassigned` row below the swimlanes.
- **Browser Playground — `empty` scenario** — blank-canvas scenario; every connector entity appears in the unassigned pool.
- **Browser Playground — lineage field preview** — pool entries expand to show typed field descriptors (`description · type · e.g. value`); FK fields have a dashed border. Channel entity groups show a `— also available —` separator with dim unmapped field nodes.
- **Browser Playground — lineage array sub-field expansion** — array fields whose items are named-property objects expand with ▸/▾ to reveal element-level properties with type and description. Array-source entity columns (e.g. `purchases.lines[]`) now resolve their sub-schema from the parent field rather than missing the lookup entirely.
- **Connector SDK — `FieldDescriptor.example`** — optional illustrative example value; display-only, engine ignores it.
- **Connector SDK — rich array item schema** — `FieldType` object `properties` is now `Record<string, FieldDescriptor>` instead of bare `FieldType` scalars, enabling `description`, `example`, and `entity` annotations on nested properties. Breaking pre-release change; no shim added.

### Changed
- **Sync Engine — `identity` key** — `identityFields` and `identityGroups` unified into a single polymorphic `identity` key. String list form is the shorthand; object list form supports compound groups. Mixed arrays are a parse-time error.
- **Sync Engine — remove `conflict: strategy: lww`** — LWW is the implicit default; `strategy` is only needed for `"field_master"` or `"origin_wins"`.

### Fixed
- **Sync Engine — multi-entity ingest** — `ingest()` collected only the first entity when a connector mapped multiple entities to the same channel. Fixed with `Array.filter()`; regression test T48 added.
- **Sync Engine — SQL syntax error on memberless channel** — `channelStatus()` and `onboardedConnectors()` returned malformed SQL for channels with zero members. Both now return early. Regression test T47 added.
- **Sync Engine — pre-flight FK warning** — cross-channel FK targets no longer produce spurious warnings.
- **Browser Playground — scroll position** — the cluster body no longer jumps to the top on every auto-poll tick.

### Testing & Quality
- Regression tests T47 (memberless channel SQL) and T48 (multi-entity ingest) added.

---

## [0.2.0] — 2026-04-07

The field-mapping pipeline release. The engine gains most of the OSI-mapping primitive set:
field expressions, normalize, defaults, atomic groups, array expansion/collapse, transitive
identity, and association predicate routing. A few primitives are still outstanding and will
land in a follow-up. A new `array-demo` playground scenario exercises the headline features
end-to-end — webshop purchases with nested line items syncing bidirectionally with a flat ERP.

### Added

- **Sync Engine — Array expansion and collapse** — JSON array fields expand into individual
  child entity records on ingest (`array_path`, `element_key`, `scalar: true`). Changes from
  flat connectors write back to the correct element via `array_parent_map`. Multi-level
  chains, element filters, and three ordering strategies (CRDT ordinal, CRDT linked-list,
  `order_by`) are all supported.
- **Sync Engine — Transitive identity closure** — `discover()` and `_resolveCanonical()` now
  use a union-find algorithm; records linked pairwise (A=B by email, B=C by taxId) collapse
  into one entity regardless of chain length.
- **Sync Engine — Compound identity groups** — `identityGroups` replaces `identityFields` for
  AND-within-group / OR-across-groups semantics; all fields in a group must match
  simultaneously.
- **Sync Engine — Association predicate mapping** — `assocMappings` translates local predicate
  names to a canonical routing key so each system receives its own name (e.g. CRM `companyId`
  and ERP `orgId` both map to `companyRef`).
- **Sync Engine — Field expressions** — `expression` / `reverseExpression` compute or combine
  canonical fields from raw source records (forward) and decompose them back into connector
  fields (reverse).
- **Sync Engine — Normalize** — a per-field `normalize` function on both sides of the noop
  diff prevents precision-loss connectors (phone formatting, float rounding) from causing
  infinite update loops.
- **Sync Engine — Defaults** — `default` (static) and `defaultExpression` (function of
  partial canonical) fill absent or null source fields during the forward pass.
- **Sync Engine — Atomic field groups** — the `group` label ensures related fields (e.g. an
  address block) all resolve from the same winning source.
- **Sync Engine — Reverse-required guard** — `reverseRequired: true` suppresses dispatch when
  a named field is absent after outbound mapping.
- **Sync Engine — Resolution strategies** — `bool_or` latches a field to `true` once any
  source sets it truthy; `resolve` accepts an arbitrary per-field reducer function.
- **Sync Engine — Target-centric noop suppression** — `written_state` records values last
  written per target connector; dispatches are suppressed when nothing has changed from the
  target's perspective.
- **Sync Engine — `RecordSyncResult` payloads** — results carry `sourceData`, `sourceShadow`,
  `before`, `after`, and association arrays; association-only changes now produce a visible
  `"read"` result.
- **Playground — `array-demo` scenario** — live end-to-end demo of array expansion/collapse;
  sub-object cards are read-only with a `⊂ entity.arrayPath` annotation and a
  `↑ parent: <id>` badge that scrolls to the parent record.
- **Playground — Notification poll** — record edits trigger a debounced 800 ms engine tick
  with a visible countdown bar and a two-phase flash (edited card instantly; synced copies
  ~800 ms later).
- **Playground — Lineage diagram** — array-source entity labels, parent-field pills,
  expression fan-in arrows, `(expression)` placeholder pills, and a resolver `ƒ` badge on
  canonical chips.
- **Playground — Association diffs in event log** — association changes render as diff rows;
  association-only changes are no longer shown as "(no field changes)".
- **Playground — UI polish** — tab activity dots, alphabetical column order, resizable shadow
  panel, flash fix for sub-object watermarks.

### Fixed

- **Sync Engine** — `onboard()` step 1b now includes remapped associations in fanout INSERTs,
  eliminating bogus empty-looking UPDATE events during warmup.
- **Sync Engine** — `onboard()` step 1 pre-fetches each side's associations before seeding
  shadow state, fixing spurious READ + UPDATE events for records with associations.
- **Sync Engine** — Removed the warmup `{ fullSync: true }` ingest pass; it was a compensating
  workaround for the onboard association bug and is no longer needed.
- **Sync Engine** — Records with empty canonical data (`{}`) now fan out correctly; the
  zero-key noop guard no longer fires for brand-new INSERTs.
- **Sync Engine** — Array-expanded children now have their source connector ID recorded in
  `identity_map` and a `shadow_state` row written, fixing empty order-line cards in the
  playground.
- **Sync Engine** — `_resolveCanonical` now searches across all entity names used by other
  channel members, fixing silent duplicate canonicals when connectors use different entity
  names.
- **Playground** — Ctrl/Cmd+Enter to save was silently swallowed in the YAML config editor
  and JSON record editor; custom bindings are now registered before `defaultKeymap`.

### Testing & Quality

- T42–T46: regression guards for onboard association bugs and empty canonical fanout.
- NA2 updated, NA11–NA12 added: source-child identity link and cross-entity-name lookup.

---

## [0.1.0] — 2026-04-06

First public release. The browser playground is live on GitHub Pages — no install, no
server, just a URL. The sync engine is pre-release; APIs and config shapes may still change.

OpenSync is a hub-and-spoke bi-directional sync engine. Data flows through a central shadow
state (SQLite), never directly between systems. This release ships:

- **Browser playground** — runs the full sync engine in the browser via WebAssembly SQLite.
  Visualises identity clusters across all connected systems, lets you edit records and channel
  config live, and shows the sync event log with before/after diffs. Three built-in scenarios
  (`two-system`, `three-system`, `associations-demo`).

- **Sync engine** (`@opensync/engine`) — bi-directional sync with canonical identity map,
  field mapping, echo detection, noop suppression, circuit breakers, OAuth2/API-key auth,
  eager association dispatch with deferred retry, and 412 ETag retry.

- **Connector SDK** (`@opensync/sdk`) — typed interface for building connectors (read, write,
  discover, webhook hooks). Reference connectors: HubSpot, Kafka, PostgreSQL, SPARQL,
  Tripletex, WaveApps.

- **Release infrastructure** — tag-triggered GitHub Actions (`release.yml`,
  `deploy-playground.yml`); pushes to `main` do not rebuild the live site.
