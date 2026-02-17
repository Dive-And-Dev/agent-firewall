FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- runtime image ----
FROM node:20-alpine AS runtime

RUN addgroup -S firewall && adduser -S firewall -G firewall

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Data directory for session persistence
RUN mkdir -p /data/sessions && chown firewall:firewall /data/sessions
VOLUME ["/data/sessions"]

USER firewall
EXPOSE 8787

CMD ["node", "dist/index.js"]
