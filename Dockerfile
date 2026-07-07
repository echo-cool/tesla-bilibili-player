# syntax=docker/dockerfile:1

# ---- Stage 1: build ----
# A single builder stage so the two `npm ci` runs happen SEQUENTIALLY. Building
# the frontend and backend as separate parallel stages runs both installs at
# once, which OOM-kills npm on small (1-2 GB) instances ("Exit handler never
# called!"). Sequential keeps peak memory low.
FROM node:22-alpine AS build
WORKDIR /app

# Frontend: install deps, then build
COPY web/package*.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web/ ./web/
RUN cd web && npm run build

# Backend: production deps only
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server/ ./server/

# ---- Stage 2: runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV WEB_DIST=/app/web/dist

COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist

WORKDIR /app/server
EXPOSE 8080
CMD ["npm", "run", "start"]
