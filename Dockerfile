FROM node:22-alpine

RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# This image *builds* the app (`npm run build` below) and the build chain —
# @remix-run/dev (which provides the `remix` binary), vite, vite-tsconfig-paths
# — lives in devDependencies. `ENV NODE_ENV=production` already makes npm omit
# devDependencies, so `--include=dev` is mandatory here; without it the build
# step dies with `sh: remix: not found`. The build-only packages are pruned
# again further down, so the shipped image keeps the same runtime footprint.
#
# Do not add `npm remove <pkg>` between this line and the build: with
# NODE_ENV=production `npm remove` re-reifies the tree with --omit=dev and
# silently deletes every devDependency again (that is what the upstream
# template's `npm remove @shopify/cli` line did — this project never depended
# on @shopify/cli, so the line was a no-op booby trap and is gone).
RUN npm ci --include=dev && npm cache clean --force

COPY . .

RUN npx prisma generate
RUN npm run build

# Back down to runtime-only dependencies (@remix-run/serve, prisma,
# @prisma/client, …). The Prisma client is regenerated on boot by
# `npm run docker-start` → `npm run setup`, so pruning cannot leave it stale.
RUN npm prune --omit=dev && npm cache clean --force

CMD ["npm", "run", "docker-start"]
