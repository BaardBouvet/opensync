#!/bin/bash
set -e

echo "🚀 Setting up OpenSync development environment..."

# Install Bun
echo "📦 Installing Bun..."
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="/home/node/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Add Bun to shell profile
echo 'export BUN_INSTALL="/home/node/.bun"' >> /home/node/.bashrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /home/node/.bashrc

# Install dependencies with Bun
echo "📚 Installing dependencies with Bun..."
bun install

# Build SDK and engine
echo "🔨 Building packages..."
bun run build

# Show helpful commands
echo ""
echo "✅ Development environment ready!"
echo ""
echo "📖 Available commands:"
echo "  bun run dev        - Start development server"
echo "  bun run test       - Run tests"
echo "  bun run build      - Build packages"
echo "  opensync --help    - CLI help"
echo ""
echo "📝 Next steps:"
echo "  1. Read /docs/getting-started.md"
echo "  2. Check /specs for architecture"
echo "  3. Start in /packages/sdk or /packages/engine"
echo ""
