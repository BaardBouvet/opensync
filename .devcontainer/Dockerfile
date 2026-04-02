# Dockerfile for OpenSync development container with Bun
FROM debian:bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
  curl \
  git \
  ca-certificates \
  sqlite3 \
  build-essential \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
  apt-get install -y nodejs && \
  rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Create app directory
WORKDIR /workspace

# Set shell to bash
SHELL ["/bin/bash", "-c"]

# Default command
CMD ["/bin/bash"]
