# KB sidecar — embedded Postgres (PGlite) + pgvector behind the gbrain REST contract.
FROM node:20-slim

WORKDIR /app

# Install prod deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source.
COPY server.mjs db.mjs embeddings.mjs chunk.mjs smoke.mjs ./
COPY README.md ./

# The brain's persistent data dir (PGLITE_DATA_DIR defaults to /data/brain).
VOLUME ["/data"]
ENV PGLITE_DATA_DIR=/data/brain

EXPOSE 8080

CMD ["node", "server.mjs"]
