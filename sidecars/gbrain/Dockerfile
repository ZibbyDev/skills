# KB sidecar — the REAL GBrain (github.com/garrytan/gbrain, MIT) behind the
# stable Zibby KB REST contract. GBrain is TypeScript-on-Bun, so the base is an
# official Bun image (not node:20-slim). GBrain is vendored as a commit-pinned
# dependency (see package.json + VENDOR.md); `bun install` fetches that exact
# commit and its deps into node_modules, which this image redistributes along
# with GBrain's MIT LICENSE.
FROM oven/bun:1

WORKDIR /app

# git is needed for bun to resolve the pinned `github:` dependency.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the pinned gbrain (+ its deps) first for better layer caching.
COPY package.json ./
RUN bun install

# Make the vendored gbrain CLI resolvable on PATH.
ENV PATH="/app/node_modules/.bin:${PATH}"

# Adapter + contract server (+ attribution + smoke test).
COPY server.js brain.js smoke.mjs GBRAIN_LICENSE VENDOR.md README.md ./

# Per-kbId brains live here (one PGLite database per tenant). Persisted volume.
VOLUME ["/data"]
ENV GBRAIN_DATA_ROOT=/data

EXPOSE 8080

CMD ["bun", "server.js"]
