FROM node:22-slim

# better-sqlite3 needs build tooling only if no prebuilt binary is available.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Persistent data (sqlite + local uploads + sessions) lives here.
# Mount a volume at /app/data in production.
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
