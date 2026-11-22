# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY scripts ./scripts
COPY src ./src

RUN npm run typecheck && npm run build

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS runtime

LABEL org.opencontainers.image.title="backup-to-proton-drive" \
      org.opencontainers.image.description="One-way SHA1-verified backup synchronization from local directories to Proton Drive via @protontech/drive-sdk" \
      org.opencontainers.image.authors="fklrtw <fklrtw@gmail.com>" \
      org.opencontainers.image.source="https://github.com/fklrtw/backup-to-proton-drive" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /data && chown -R node:node /data && chmod 700 /data

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist/index.js ./dist/index.js
COPY --from=builder /app/dist/index.js.map ./dist/index.js.map

USER node

ENV NODE_ENV=production \
    SESSION_FILE=/data/session.json \
    STATE_FILE=/data/state.json

VOLUME ["/data"]

ENTRYPOINT ["node", "/app/dist/index.js"]
