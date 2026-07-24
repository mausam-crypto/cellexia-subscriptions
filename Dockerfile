FROM node:22-alpine

RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app

COPY package.json package-lock.json* ./
# NODE_ENV=production is NOT set yet here — npm treats that env var as an
# implicit --omit=dev regardless of the install flags used, and the build
# step below (`remix vite:build`) needs @remix-run/dev and vite, both
# devDependencies. It's set further down, right before CMD, so it only
# affects the running app, not this install/build.
RUN npm ci && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli 2>/dev/null || true

COPY . .

RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
CMD ["npm", "run", "docker-start"]
