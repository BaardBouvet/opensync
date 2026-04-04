# two-system

Two jsonfiles connector instances syncing a shared `contacts` channel bidirectionally.

```
bun run demo
```

## Seed data

| System   | Contacts seeded |
|----------|----------------|
| system-a | Alice, Bob, Carol |
| system-b | Alice, Bob       |

On first run the engine matches Alice and Bob by email and propagates Carol from system-a to
system-b. After onboarding both files contain all three contacts and subsequent polls produce
no writes (steady state).

## Try it

Edit either JSON file while the runner is polling — the change appears on the other side
within one poll interval (default 2 s).

```
demo/data/two-system/
  system-a/contacts.json
  system-b/contacts.json
```

Add a record:

```json
{ "_id": "a4", "name": "Dave Owen", "email": "dave@example.com", "_updatedAt": "2026-01-01T00:00:00.000Z" }
```

Update the `_updatedAt` timestamp on an existing record to trigger an update sync.

## Reset

```
rm -rf demo/data/two-system
```
