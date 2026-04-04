# OpenSync Demo

Interactive sync demos that run against the packaged `@opensync/engine`.

## Quick start

```sh
bun run demo
```

Starts the **two-system** example: two local JSON file systems sync contacts bidirectionally.

## Available examples

| Example | Command | What it shows |
|---------|---------|---------------|
| `two-system` _(default)_ | `bun run demo` | Two jsonfiles connectors, bidirectional contacts sync |
| `three-system` | `bun run demo/run.ts -d three-system` | Three connectors, hub-and-spoke fan-out |
| `mock-crm-erp` | `bun run demo/run.ts -d mock-crm-erp` | CRM + ERP over HTTP with auth — [requires servers](examples/mock-crm-erp/README.md) |

The `-d` flag takes any folder containing an `opensync.json` file — built-in examples by
name (`-d two-system`) or any path to a custom example (`-d /path/to/my-example`).

## How it works

1. **First run**: seed data is copied from `<example-dir>/seed/` into `demo/data/<name>/`,
   then the engine runs `collect → discover → onboard` to link matching records across systems.
2. **Polling**: every `POLL_MS` ms (default 2 s) the engine ingests all connectors and prints
   any writes: `[HH:MM:SS.mmm] system-a→system-b  INSERT  contacts  abc12345… → def67890…`
3. **Persistence**: state lives in `demo/data/<name>/state.db`. Restart picks up where it left off.

Stop with **Ctrl+C**. Set `POLL_MS=500` for faster polling.

Each example has its own `README.md` with setup details and interactive instructions.

For jsonfiles examples, edit any JSON file under `demo/data/<name>/` while the runner is
polling — the change propagates to the other system on the next tick.

## Resetting

```sh
rm -rf demo/data/<name>
```


