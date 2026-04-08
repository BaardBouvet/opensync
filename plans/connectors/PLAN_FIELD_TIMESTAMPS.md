# PLAN: `ReadRecord.fieldTimestamps` — Connector-Native Per-Field Timestamps

**Status:** complete  
**Date:** 2026-04-08  
**Effort:** XS  
**Domain:** Connector SDK, Engine  
**Scope:** `packages/sdk/src/types.ts`, `specs/connector-sdk.md`, `specs/field-mapping.md`  
**Depends on:** nothing (companion to `PLAN_READ_RECORD_UPDATED_AT`; see also `plans/engine/PLAN_FIELD_TIMESTAMPS.md`)  

---

## § 1 Problem Statement

`ReadRecord.updatedAt` provides a single modification timestamp for an entire record. Some APIs
expose per-field modification times — Salesforce field history, HubSpot property-level timestamps,
audit columns on individual fields. A record-level timestamp cannot distinguish between "the email
address changed" and "the phone number changed."

Without a native SDK field for per-field timestamps, connectors have two bad options:

1. Return field timestamps as data in `Record.data` — pollutes the canonical record with API
   metadata. The engine operator must then know which columns are timestamps and configure them
   away, which is an engine concern bleeding into connector design.
2. Drop the information — losing the precision that per-field LWW resolution needs.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | `ReadRecord` section | Document `fieldTimestamps` field: optional, `Record<string, string>` keyed by canonical field name, ISO 8601 values. Note that keys must match field names as they appear in `data`. |
| `specs/field-mapping.md` | §1.9 | Replace `lastModifiedField` config description with the connector-native approach: connectors provide `fieldTimestamps`; engine consumes it as the highest-priority source in the per-field timestamp chain (§7.2). |

---

## § 3 Design

### § 3.1 SDK addition

Add `fieldTimestamps` to `ReadRecord` in `packages/sdk/src/types.ts`:

```ts
export interface ReadRecord {
  id: string;
  data: Record<string, unknown | unknown[]>;
  deleted?: boolean;
  associations?: Association[];
  version?: string;
  updatedAt?: string;
  createdAt?: string;

  /** Per-field modification timestamps, keyed by the same field names used in `data`.
   *  Values are ISO 8601 strings (e.g. '2024-06-01T12:00:00Z').
   *  When present, the engine uses these as the LWW timestamp for the named fields,
   *  taking precedence over shadow-state derivation and `updatedAt`.
   *  Fields absent from this map fall back to shadow derivation and then `updatedAt`.
   *  The connector is responsible for keeping timestamp columns out of `data`.
   *  Omit entirely for connectors that do not expose per-field modification times.
   *  Spec: specs/field-mapping.md §7.2 */
  fieldTimestamps?: Record<string, string>;
}
```

The keys match the field names in `data` after any normalization the connector applies.
The connector is responsible for mapping API-native timestamp columns to the correct field names
and for excluding those columns from `data`.

### § 3.2 Engine consumption

Consumed by `computeFieldTimestamps` in `packages/engine/src/core/mapping.ts` as the
highest-priority source in the per-field timestamp chain. No additional engine changes are needed
beyond what `plans/engine/PLAN_FIELD_TIMESTAMPS.md` describes.

---

## § 4 Example: HubSpot per-property timestamps

HubSpot exposes a property-level `updatedAt` for each contact property. Without `fieldTimestamps`
a connector would have to litter `data` with timestamp columns or lose the information entirely.
With `fieldTimestamps` the connector author expresses the correct semantics cleanly:

```ts
{
  id: contact.id,
  updatedAt: contact.updatedAt,
  fieldTimestamps: {
    email: contact.properties.email_last_updated,
    phone: contact.properties.phone_last_updated,
  },
  data: {
    email: contact.properties.email,
    phone: contact.properties.phone,
  },
}
```

The engine resolves LWW at the field level even if both `email` and `phone` appear in the same
record — if only one actually changed, the other carries forward its prior shadow timestamp and
does not win resolution against an older but still-valid value in another system.

---

## § 5 Implementation Steps

1. Add `fieldTimestamps?: Record<string, string>` to `ReadRecord` in
   `packages/sdk/src/types.ts`.
2. Update `specs/connector-sdk.md` — document `fieldTimestamps` in the `ReadRecord` section.
3. Update `specs/field-mapping.md §1.9` — replace the `lastModifiedField` config description
   with the connector-native `fieldTimestamps` approach.
