# Frequently Asked Questions

## Conflict Resolution

### What does "last-write-wins" (LWW) actually mean here?

LWW is the default conflict resolution strategy. It operates at the **field level**, not the record level — each field is decided independently using a timestamp stored in the shadow state for every (connector, field) pair.

When a sync cycle ingests a new value for a field, the engine compares its timestamp against the timestamp already stored in the shadow state for that field from whatever source last wrote it. If the incoming timestamp is equal to or newer, the incoming value wins and is propagated to all other connectors. If it is older, it is dropped.

**Where the timestamp comes from (in priority order):**

1. `ReadRecord.fieldTimestamps[field]` — a per-field timestamp provided directly by the connector (e.g. Salesforce field history, HubSpot property-level timestamps).
2. `ReadRecord.updatedAt` — the record-level last-modified time reported by the connector. Used for all fields that don't have their own timestamp.
3. Declaration order — when timestamps are null for both sides, the connector listed first in the channel config wins.

**Tie-breaking:** When two sources have the same timestamp for a field, the source with the **earlier** `createdAt` wins. The logic is that the younger record is likely a downstream copy that should not overwrite the original.

**LWW only applies to fields not covered by a `field_master` rule.** If a field has an explicit master connector, that connector always wins regardless of timestamps.

LWW can produce incorrect results if system clocks are skewed or if a connector does not expose meaningful timestamps (in which case all fields on a record get the same `updatedAt`, and rapid back-to-back changes within one sync cycle may not be ordered correctly). Use `field_master` rules for fields that have a clear authoritative source.

### What happens to `field_master` fields when the record was created in the non-master system?

`field_master` only governs **updates to fields that already have a shadow-state entry**. It does not block the initial write from any source.

When a record is ingested for the first time — whether from the master or a non-master connector — the engine has no prior shadow to compare against and accepts every field unconditionally. This seeds the canonical record with whatever values the originating connector provided, including fields that are mastered by a different connector.

From that point, the life of a master-owned field follows this sequence:

1. **Non-master creates the record.** Its value for the master-owned field (e.g. `email = "erp@example.com"`) is written into the canonical shadow and dispatched to all other connectors, including the master system. The field now has a shadow entry attributed to the non-master source.
2. **Master syncs for the first time.** The master's value for that field arrives. Because the field now has a shadow entry, conflict resolution runs and `fieldMasters` applies: the incoming source *is* the master, so its value wins and overwrites the canonical. The corrected value is then dispatched back to non-master connectors.
3. **All subsequent non-master updates to that field are blocked.** The shadow entry now exists, `fieldMasters` fires, and the non-master is not the declared master — so its update is silently dropped and the master's value is preserved.

The practical implication: for a brief window (between the non-master's first ingest and the master's first sync cycle), the master-owned field may contain the non-master's value. If that value is wrong, the master will correct it on its next poll. For fields where even a transient incorrect value is unacceptable, the non-master connector's mapping should omit those fields entirely so they are never populated from that source.

### What if two non-master systems both have an initial value for a master-owned field?

Each connector is collected independently (`collectOnly`), so both non-master systems get their own shadow rows seeded with their own values before any fan-out occurs. By the time cross-linking and fan-out begin, both shadows already have an `existing` entry for the master-owned field — attributed to their own connector ID.

Because both shadows have an existing entry, `fieldMasters` applies on every subsequent fan-out. Neither non-master connector is the declared master, so each one's attempt to update the other is silently dropped. The result: **both non-master systems retain their own divergent values for the field, with no convergence between them**, until the master connector syncs.

When the master finally syncs, its value is accepted (it is the declared master) and fanned out to both non-master systems. At that point both shadows are overwritten with the master's value and they converge.

The practical consequence: if you have two non-master systems with different pre-existing values for a master-owned field, do not expect them to agree with each other until the master has run at least one sync cycle. If the interim divergence is a problem, run the master's collection pass before onboarding the non-master systems.

---

## Identity & Clusters

### What happens when two clusters are merged?

A *cluster* is a group of records across connected systems that the engine has
determined represent the same real-world entity. Each cluster has a single
**canonical ID** in the shadow state.

When two clusters are merged — because a new identity link is discovered that
bridges them — the engine reassigns everything from the losing canonical to the
winning canonical:

- All identity-map entries (external IDs from every connector) are repointed to
  the winning canonical ID.
- All shadow-state rows are repointed to the winning canonical ID.
- The losing canonical ID ceases to exist.

From that point on, every connector in the channel sees a unified view: reads
and writes are coordinated under the single merged canonical, and the next sync
cycle propagates any missing fields in either direction.

Merges are irreversible without a full rollback. If an incorrect merge occurs
(e.g. two distinct real-world entities were matched by mistake), the only
supported remedy is to roll back to the snapshot taken before the offending
sync run.
