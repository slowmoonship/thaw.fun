FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @shipfun/web...
COPY apps/web apps/web
RUN pnpm --filter @shipfun/web build
FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /usr/share/caddy
