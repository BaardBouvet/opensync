# Configuration

OpenSync uses a **project root directory** convention (similar to docker-compose or Vite). All
config lives in a directory; the CLI discovers it from the current working directory or from an
explicit `--root <dir>` flag.

## Project Structure

```
my-sync-project/
├── opensync.json        # connector registry
├── mappings/
│   ├── channels.yaml    # explicit channel definitions
│   ├── customers.yaml   # field mappings for the "customers" channel
│   └── orders.yaml      # field mappings for the "orders" channel
└── data/                # state + cached records (generated, add to .gitignore)
```

### Convention rules

- `opensync.json` must be present at the root.
- `mappings/` must be present and contain at least one `channels.yaml` (or any file with a
  top-level `channels` key).
- Mapping files can be split however the user likes — by entity, by channel, or all in one file.
  OpenSync merges all `.yaml`, `.yml`, and `.json` files in `mappings/` **alphabetically** into a
  single mapping set.
- `data/` is generated at runtime. It should be in `.gitignore`.

---

## `opensync.json` — Connector Registry

Lists every connector instance available to this project. The key is the **connector ID**
referenced throughout the mappings.

```json
{
  "connectors": {
    "hubspot": {
      "plugin": "@opensync/connector-hubspot",
      "config": {
        "accessToken": "${HUBSPOT_ACCESS_TOKEN}"
      }
    },
    "fiken": {
      "plugin": "@opensync/connector-fiken",
      "config": {
        "companySlug": "my-company",
        "token": "${FIKEN_TOKEN}"
      }
    }
  }
}
```

### `plugin`

The npm package name of the connector, e.g. `@opensync/connector-hubspot`. During development,
a relative path to a local TypeScript file is also accepted:

```json
"plugin": "./connectors/my-connector/src/index.ts"
```

### `config`

Connector-specific config object — passed verbatim to the connector's `ConnectorContext.config`.
The shape is defined by each connector. Environment variable interpolation (`${VAR}`) is resolved
at load time for **string** values.

### `auth`

Auth credentials — kept separate from `config` so connector-specific config keys never collide
with credential names. Auth credentials are resolved, env-var-interpolated, and passed to the
engine auth layer; connectors never receive them directly (they call `ctx.http()` instead).

```json
{
  "connectors": {
    "crm": {
      "plugin": "@opensync/connector-hubspot",
      "auth": {
        "apiKey": "${HUBSPOT_ACCESS_TOKEN}"
      },
      "config": {
        "baseUrl": "https://api.hubspot.com"
      }
    },
    "erp": {
      "plugin": "@opensync/connector-netsuite",
      "auth": {
        "clientId": "${NETSUITE_CLIENT_ID}",
        "clientSecret": "${NETSUITE_CLIENT_SECRET}"
      },
      "config": {
        "accountId": "${NETSUITE_ACCOUNT_ID}"
      }
    }
  }
}
```

Recognised credential keys (see `specs/auth.md §Credentials in opensync.json`):
- `apiKey` (also `api_key`, `accessToken`) — static API key / bearer token
- `clientId` (also `client_id`) + `clientSecret` (also `client_secret`) — OAuth2 client credentials

`${VAR}` interpolation applies to all string values in `auth` the same way as `config`.

Nested objects are also valid config values. This is intentional but not user-friendly — reserved
for cases where a whole JSON document must be supplied, such as a GCP service account key file or
an Azure service principal:

```json
{
  "connectors": {
    "azure-storage": {
      "plugin": "@opensync/connector-azure-storage",
      "config": {
        "containerName": "my-container",
        "servicePrincipal": {
          "clientId": "...",
          "clientSecret": "...",
          "tenantId": "..."
        }
      }
    }
  }
}
```

Note: `${VAR}` interpolation is **not** applied inside nested objects. To source a credential from
an environment variable use a top-level string field instead.

---

## `mappings/channels.yaml` — Channel Definitions

Channels define the **sync rings**: every connector mapped to a channel receives changes from every
other member. Keeping channels explicit (rather than deriving them from mappings) makes the
structure readable and makes room for future metadata.

```yaml
channels:
  - id: contacts
  - id: invoices
```

Optional channel metadata:

```yaml
channels:
  - id: contacts
    # identityFields: OR-per-field matching. Each field is its own group.
    # Records sharing a value on ANY listed field are linked (transitive).
    # See identity.md for full semantics.
    identityFields:
      - email
      - taxId

    # identityGroups: compound (AND-within-group, OR-across-groups). Takes precedence
    # over identityFields when both are present.
    # identityGroups:
    #   - fields: [email]
    #   - fields: [firstName, lastName, dob]

    conflict_resolution: lww        # last-write-wins (future)
    circuit_breaker:                # future
      volume_threshold: 100
```

`identityFields` / `identityGroups` are the primary configuration point for field-value-based record matching. When set, the engine uses a union-find (connected-components) algorithm to identify records that represent the same real-world entity across connectors, supporting transitive chains (A=B via email, B=C via taxId → A=B=C). See `specs/identity.md § Field-Value-Based Matching` for full semantics, trade-offs, and the compound-group (`identityGroups`) syntax.

---

## `mappings/*.yaml` — Field Mappings

One or more files, each containing a top-level `mappings` array. A single file is fine; split by
entity, channel, or any other grouping that makes sense for the project.

```yaml
# mappings/customers.yaml
#
# Canonical field: customerName
#   hubspot  stores "firstname" + "lastname"  ↔  customerName
#   fiken    stores "name"                    ↔  customerName

mappings:
  - connector: hubspot
    channel: contacts
    entity: contacts
    fields:
      - source: firstname
        target: customerName
      - source: email
        target: email           # same name, still listed to opt-in (whitelist)

  - connector: fiken
    channel: contacts
    entity: customers
    fields:
      - source: name
        target: customerName
      - source: email
        target: email
```

### Field whitelist semantics

`fields` is a **whitelist**. Only listed fields are synced. Unlisted fields on the source record are
dropped before writing to the target.

If `fields` is omitted entirely, all fields pass through verbatim (no rename, no filtering). This
is a convenience for connectors that already speak the canonical field names.

### Field direction

| `direction`       | Inbound (source → canonical) | Outbound (canonical → target) |
|-------------------|------------------------------|-------------------------------|
| `bidirectional`   | ✓ (default)                  | ✓                             |
| `reverse_only`    | ✓                            | ✗                             |
| `forward_only`    | ✗                            | ✓                             |

- `reverse_only` — read from this connector but never write back to it (e.g. a read-only audit source)
- `forward_only` — injected when writing to this connector but ignored when reading back (e.g. a constant or computed field the connector provides itself)

```yaml
fields:
  - source: internalNotes
    target: notes
    direction: reverse_only    # never write back to source
```

### Associations

Associations (foreign-key style links between entities) are remapped across connectors using
the identity map. To enable forwarding, each connector's mapping entry must declare an optional
`associations` list mapping its local predicate names to a canonical name:

```yaml
# mappings/contacts.yaml (excerpt)
- connector: crm
  channel: contacts
  entity: contacts
  fields:
    - source: name
      target: name
  associations:
    - source: companyId   # CRM-local predicate
      target: companyRef  # canonical routing key — never stored in shadow state

- connector: erp
  channel: contacts
  entity: employees
  associations:
    - source: orgId       # ERP-local predicate
      target: companyRef  # same canonical → same edge
```

Absent `associations` on a mapping entry → no associations are forwarded from or to that
connector. See `specs/associations.md § 7.5` for full rules.

---

### Array expansion keys

For nested-array expansion (specs/field-mapping.md §3.2), the following optional keys are
available on a mapping entry:

| Key | Type | Meaning |
|-----|------|---------|
| `name` | `string` | Stable identifier for this mapping entry. Required when another entry references it via `parent:`. Must be unique across all mapping files. |
| `parent` | `string` | Name of the parent mapping entry. The child inherits the parent's `connector` and reads from the parent's `entity`. `array_path` must also be set. |
| `array_path` | `string` | Dotted path to the JSON array column on the source record (`lines`, `order.lines`). Required when `parent` is set. |
| `parent_fields` | `object` | Parent source fields to bring into scope for element field mapping. Key = local alias used in the child's `source:` entries; value = parent field name (string) or `{ path?, field }` for deep nesting. |
| `element_key` | `string` | Field within each array element providing a stable identity. Falls back to element index when absent. |

**Same-channel example** (parent and child in same channel):

```yaml
# parent — source descriptor; not a fan-out target in this channel
- name: erp_orders
  connector: erp
  channel: order-lines
  entity: orders

# child — expands parent records into per-line records
- channel: order-lines
  parent: erp_orders          # inherits connector=erp, reads entity=orders
  array_path: lines
  parent_fields:
    order_id: order_id
  element_key: line_no
  fields:
    - source: line_no
      target: lineNumber
    - source: product_id
      target: productId
    - source: order_id
      target: orderRef

# flat target connector
- connector: crm
  channel: order-lines
  entity: order_lines
  fields: [...]
```

**Cross-channel example** (parent in one channel, child references it across channels):

```yaml
# parent is a regular member of the 'orders' channel
- name: erp_orders
  connector: erp
  channel: orders
  entity: orders
  fields: [...]

# child in 'order-lines' channel references the parent by name
- connector: erp
  channel: order-lines
  entity: order_lines
  parent: erp_orders
  array_path: lines
  element_key: line_no
  fields: [...]
```

---

```
# Use CWD as the project root (standard case)
opensync run

# Point to an explicit project root
opensync run --root /path/to/my-sync-project

# Future: auto-discover by walking up directories (like git)
# opensync run   ← works from any subdirectory
```

The `--root` flag is the only override. There are no separate `--config` or `--mappings` flags —
`opensync.json` and `mappings/` are always co-located by convention.

---

## Validation

All config is validated at load time before any sync runs:

- `opensync.json` must have a `connectors` object (not an array).
- Each `mappings/*.yaml` must have a `mappings` array or a `channels` array (or both); unknown
  top-level keys are ignored.
- A mapping referencing an unknown connector ID or channel ID is a hard error.
- Plugin load failures (missing package, no `metadata` export) are hard errors.

Invalid config fails fast with a clear message before touching any external system.

---

## Design Rationale: Why Three-Section Config

The `opensync.json` + `mappings/` structure separates three orthogonal concerns:

1. **Connector instances** (`opensync.json`) — which systems exist and how to connect (credentials, base URL, plugin name). One entry per instance. Edited when adding or removing a system.

2. **Channels** (`mappings/channels.yaml`) — what syncs (groups of members, identity fields, future conflict rules). Edited when adding a new sync ring or changing channel metadata.

3. **Field mappings** (`mappings/*.yaml`) — how fields flow between each connector and each channel. One entry per connector×channel pair. Edited when a field is added, renamed, or a new connector joins an existing channel.

**Why not a single flat file?** Channel-centric flat config (`ChannelMember` inline) means adding a connector requires editing every channel block — the diff is scattered. Connector-centric grouping means adding a channel requires editing every connector block — same problem inverted. A three-section file confines each operation to its own section: adding a connector adds entries to `connectors` and `mappings` only; adding a channel adds an entry to `channels` and `mappings` only. Code review diffs are cleanly scoped.

**File splitting is opt-in.** The engine merges all `mappings/*.yaml` files alphabetically. A single file is fine for small projects; larger teams can split by entity, by team, or by connector without any schema changes. Each file must have at least one of a top-level `channels` or `mappings` key.

**One document in version control.** The config describes wiring, not runtime state. Everything in `opensync.json` and `mappings/` should be committed and code-reviewed. Generated runtime state goes in `data/` which is gitignored.

