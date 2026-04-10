FROM node:24-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM dependencies AS build

WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime

# Container deployments are configured through environment variables.
# The local YAML config file is intentionally only for plain npm starts.
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8000
ENV HTTP_BODY_LIMIT_BYTES=524288000
ENV DATA_PATH=/data
ENV STATE_BACKEND=file
ENV LOG_ENABLED=true
ENV LOG_LEVEL=info
WORKDIR /app

RUN addgroup -S app \
  && adduser -S app -G app \
  && mkdir -p /data \
  && chown app:app /data

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/src/server.js"]
