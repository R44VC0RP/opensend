FROM node:24-alpine AS dashboard
WORKDIR /dashboard
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

FROM node:24-alpine AS build
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/tsconfig*.json api/worker-configuration.d.ts ./
COPY api/src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=dashboard /dashboard/dist ./public
COPY api/migrations ./migrations
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
