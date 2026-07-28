FROM node:22-alpine

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
