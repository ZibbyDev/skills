# NODE PIN (2026-10-22): the EXACT Node release carrying the 2026-10-21
# security fixes (CVE-2026-111497 Brotli decoder OOB write, TLS hostname
# validation bypasses), never the floating tag; the RUN below fails the build
# if the base's Node is anything else (a pin without an assert is a wish).
ARG NODE_VERSION=22.23.4
FROM node:${NODE_VERSION}-alpine
ARG NODE_VERSION
RUN got="$(node --version)"; [ "$got" = "v${NODE_VERSION}" ] \
      || { echo "NODE PIN MISMATCH: base runs Node $got, NODE_VERSION says v${NODE_VERSION}" >&2; exit 1; }; \
    echo "node $got ok"

WORKDIR /app

# npm ci against the committed lockfile: two per-arch builds must resolve
# byte-identical dependency trees.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8090/health || exit 1

CMD ["node", "src/server.js"]
