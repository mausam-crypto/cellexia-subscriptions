FROM node:22-alpine

RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# Full install (not --omit=dev): the build step below runs `remix vite:build`,
# which needs @remix-run/dev and vite — both devDependencies. Runtime itself
# only needs the regular dependencies (remix-serve, prisma client, etc.), but
# this is a single-stage image, so devDependencies stay in the final image.
RUN npm ci && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli 2>/dev/null || true

COPY . .

RUN npx prisma generate
RUN npm run build

CMD ["npm", "run", "docker-start"]
