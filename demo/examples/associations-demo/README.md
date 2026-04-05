# associations-demo

Three jsonfiles connectors (`crm`, `erp`, `hr`) syncing two channels (`companies`, `contacts`) with field renames and associations.

```
bun run demo/run.ts -d associations-demo
```

## What it demonstrates

- **Field renames** — each system uses different field names for the same concept; the channel mapping translates them to a canonical schema:

  | Canonical | crm | erp | hr |
  |-----------|-----|-----|----|
  | `name` (company) | `name` | `accountName` | `orgName` |
  | `domain` | `domain` | `website` | `site` |
  | `name` (contact) | `name` | `fullName` | `displayName` |
  | `companyId` | `companyId` | `orgId` | `orgRef` |

- **Associations** — each contact record declares an association linking its company reference to the `companies` entity. The engine resolves these across system boundaries via the identity map.

- **Two-channel ordering** — `companies` is synced before `contacts` so company identity is established first.

## Seed data

| Connector | Companies seeded | Contacts seeded |
|-----------|-----------------|-----------------|
| crm       | Acme, Globex, Initech | Alice (Acme), Bob (Globex), Carol (Initech) |
| erp       | Acme, Globex          | Alice (Acme), Bob (Globex) |
| hr        | Globex, Initech       | Bob (Globex), Carol (Initech) |

After onboarding: all three connectors know all three companies and all three contacts.

## Try it

Edit any data file and watch changes propagate:

```
demo/data/associations-demo/crm/contacts.json
demo/data/associations-demo/erp/employees.json
demo/data/associations-demo/hr/people.json
```

Inspect the engine's internal state:

```
bun run demo/inspect.ts -d associations-demo
```
