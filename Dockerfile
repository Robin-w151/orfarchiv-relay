ARG BASE_IMAGE=node:24-alpine

FROM ${BASE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts

COPY . .

RUN npm run build


FROM ${BASE_IMAGE} AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/relay.js .

USER 1000:1000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["node", "relay.js"]
