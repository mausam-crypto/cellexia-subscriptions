FROM node:20-alpine

RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app

COPY package.json package-lock.json* ./

# NODE_ENV is NOT set yet here — npm treats that env var as an implicit
# --omit=dev regardless of the install flags used, and the build step below
# (`remix vite:build`) needs @remix-run/dev and vite, both devDependencies.
# It's set further down, right before CMD, so it only affects the running
# app, not this install/build.
RUN npm ci

COPY . .

# Regenerate the Prisma Client against the Postgres schema at build time too
# — not just at container boot via docker-start's setup:postgres. Belt and
# suspenders: if a host ever serves a cached image/layer without re-running
# CMD's generate step, the client baked into this image is still current
# with prisma/postgres/schema.prisma's models.
RUN npx prisma generate --schema prisma/postgres/schema.prisma

RUN npm run build

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
