# syntax=docker/dockerfile:1
# marshmemos server image (API and worker share it; the worker service overrides the start command).
# Build context is the repository root: `docker build -f apps/server/Dockerfile .`

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@10.33.0 --no-fund --no-audit
WORKDIR /app

# Install only what the server (and its workspace dependencies) needs.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/mobile/package.json apps/mobile/
COPY packages/contracts/package.json packages/contracts/
COPY packages/content/package.json packages/content/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile --filter @marshmemos/server...

# Bundle the API, worker and migrate entry points (workspace packages are bundled in).
FROM deps AS build
COPY apps/server apps/server
COPY packages/contracts packages/contracts
COPY packages/content packages/content
COPY supabase supabase
RUN pnpm --filter @marshmemos/server build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/server/package.json /app/apps/server/package.json
COPY --from=build /app/apps/server/node_modules /app/apps/server/node_modules
COPY --from=build /app/apps/server/dist /app/apps/server/dist
USER node
WORKDIR /app/apps/server
EXPOSE 8787
CMD ["node", "dist/api.js"]
