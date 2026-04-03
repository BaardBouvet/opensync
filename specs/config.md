# Configuration

OpenSync uses a **project root directory** convention (similar to docker-compose or Vite). All
config lives in a directory; the CLI discovers it from the current working directory or from an
explicit `--root <dir>` flag.

## Project Structure

```
my-sync-project/
├── openlink.json        # connector registry
├── mappings/
│   ├── channels.yaml    # explicit channel definitions
│   ├── customers.yaml   # field mappings for the "customers" channel
│   └── orders.yaml      # field mappings for the "orders" channel
└── data/                # state + cached records (generated, add to .gitignore)
```

### Convention rules

- `openlink.json` must be present at the root.
- `mappings/` must be present and contain at least one `channels.yaml` (or any file with a
  top-level `channels` key).
- Mapping files can be split however the user likes — by entity, by channel, or all in one file.
  OpenSync merges all `.yaml`, `.yml`, and `.json` files in `mappings/` **alphabetically** into a
  single mapping set.
- `data/` is generated at runtime. It should be in `.gitignore`.

---

## `openlink.json` — Connector Registry

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
at load time.

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

Future metadata candidates per channel:

```yaml
channels:
  - id: contacts
    conflict_resolution: lww        # last-write-wins (future)
    circuit_breaker:                # future
      volume_threshold: 100
```

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
| `read_only`       | ✓                            | ✗                             |
| `write_only`      | ✗                            | ✓                             |

```yaml
fields:
  - source: internalNotes
    target: notes
    direction: read_only    # never write back to source
```

### Associations

Associations (foreign-key style links between entities) are synced automatically — no declaration
needed in the mapping. The engine remaps `targetId` across connectors using its identity map.

---

## CLI Discovery

```
# Use CWD as the project root (standard case)
opensync run

# Point to an explicit project root
opensync run --root /path/to/my-sync-project

# Future: auto-discover by walking up directories (like git)
# opensync run   ← works from any subdirectory
```

The `--root` flag is the only override. There are no separate `--config` or `--mappings` flags —
`openlink.json` and `mappings/` are always co-located by convention.

---

## Validation

All config is validated at load time before any sync runs:

- `openlink.json` must have a `connectors` object (not an array).
- Each `mappings/*.yaml` must have a `mappings` array or a `channels` array (or both); unknown
  top-level keys are ignored.
- A mapping referencing an unknown connector ID or channel ID is a hard error.
- Plugin load failures (missing package, no `metadata` export) are hard errors.

Invalid config fails fast with a clear message before touching any external system.

