# Development Environment

Quick setup for OpenSync development with Bun.

## VS Code DevContainer (Recommended)

Easiest setup if you use VS Code:

1. Install [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) for VS Code
2. Open the project folder in VS Code
3. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac), type "Dev Containers: Reopen in Container"
4. Wait for setup to complete (~2-3 minutes)

The container automatically:
- Installs Bun
- Installs all dependencies
- Builds packages
- Sets up VS Code extensions

**Ready to go!** You're now in a containerized environment with Bun, Node, SQLite, and everything else.

```bash
# Inside the container:
bun run dev       # Start development server
bun run test      # Run tests
bun run build     # Build packages
```

## Local Setup

Prefer running directly on your machine?

**Requirements:**
- Bun 1.0+: https://bun.sh
- Node 20+: https://nodejs.org
- SQLite3: Usually pre-installed; if not: `brew install sqlite3` (Mac) or `apt install sqlite3` (Linux)

**Setup:**
```bash
# Install dependencies
bun install

# Build packages
bun run build

# Verify
bun --version
node --version
sqlite3 --version
```

## Project Structure

```
opensync/
├── packages/
│   ├── sdk/              # @opensync/sdk — connector interfaces
│   └── engine/           # @opensync/engine — core sync logic
├── connectors/
│   ├── mock-crm/         # Example: in-memory CRM
│   ├── mock-erp/         # Example: in-memory ERP
│   └── mock-file/        # Example: JSON file connector
├── docs/                 # User-facing documentation
├── specs/                # Implementation specs (for us)
└── tests/                # Integration tests
```

## Common Commands

### Development

```bash
# Watch mode for active development
bun run dev

# Run all tests
bun run test

# Run specific test file
bun run test tests/integration/sync.test.ts

# Watch tests
bun run test:watch

# Format code
bun run format

# Lint
bun run lint
```

### Building

```bash
# Build all packages
bun run build

# Build specific package
cd packages/sdk && bun run build

# Clean build artifacts
bun run clean
```

### Connectors

```bash
# Run local sync between mock connectors
bun run sync:local --source mock-crm --target mock-erp

# Test a connector
bun run test:connector connectors/mock-file
```

## Troubleshooting

**Bun installation fails in container?**
- The post-create script handles it. If it fails, manually run:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  export PATH="/home/node/.bun/bin:$PATH"
  ```

**Dependencies won't install?**
- Clear cache and reinstall:
  ```bash
  rm -rf node_modules bun.lockb
  bun install
  ```

**Port 3000 already in use?**
- Modify port mapping in `docker-compose.yml` or specify different port

**Permissions issues on Linux?**
- Ensure Docker daemon is running: `sudo systemctl start docker`
- Add your user to docker group: `sudo usermod -aG docker $USER`

## Debugging

### VS Code Debugging

Breakpoints and step-through debugging are configured:

1. Set a breakpoint in VS Code
2. Run: `bun run test:debug` (for tests)
3. Debugger will pause at breakpoints

### Manual Logging

```typescript
// Simple console logging (shows in terminal)
console.log('Debug info:', variable);

// Structured logging (shows in logs/)
ctx.logger.info('Sync started', { channelId: 'foo' });
```

### SQLite Inspection

```bash
# Connect to the dev database
sqlite3 ./data/opensync.db

# View tables
.tables

# Query shadow state
SELECT * FROM shadow_state LIMIT 5;
```

## Next Steps

1. Read [Getting Started](../docs/getting-started.md)
2. Explore [Architecture Overview](../specs/overview.md)
3. Start with [Building Your First Connector](../docs/connectors/guide.md)

---

**Stuck?** Check the docs or open an issue on GitHub.
