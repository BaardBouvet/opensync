# three-system

Three jsonfiles connectors syncing a shared `contacts` channel — demonstrates hub-and-spoke fan-out.

```
bun run demo/run.ts -d three-system
```

## Seed data

| System   | Contacts seeded |
|----------|----------------|
| system-a | Alice, Bob       |
| system-b | Alice, Bob       |
| system-c | Carol            |

On first run: Alice and Bob matched across A/B, Carol is unique to C and propagated to A and B.
After onboarding all three systems contain Alice, Bob, and Carol.

## Try it

```
demo/data/three-system/
  system-a/contacts.json
  system-b/contacts.json
  system-c/contacts.json
```

Edits to any file propagate to the other two — the engine fans out through the channel.

## Reset

```
rm -rf demo/data/three-system
```
