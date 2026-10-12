FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/push-worker.ts scripts/build-workers.mjs ./scripts/
COPY src ./src
RUN npm run build:workers && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
USER node
CMD ["node", "build/push-worker.cjs"]
