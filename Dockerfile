FROM oven/bun:1.3.5-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.5-alpine AS builder
WORKDIR /app
ARG BASE_PATH=/
ARG HOME_URL=
ENV BASE_PATH=$BASE_PATH
ENV HOME_URL=$HOME_URL
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.5-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV STATIC_ROOT=/app/dist
ENV BASE_PATH=/
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --from=builder --chown=bun:bun /app/src/server.ts ./src/server.ts
COPY --from=builder --chown=bun:bun /app/src/server ./src/server
COPY --from=builder --chown=bun:bun /app/src/shared ./src/shared
COPY --chmod=755 entrypoint.sh /entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
