# Один Dockerfile на все сервисы: docker build --build-arg SERVICE=wallet-service .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
# Сначала только манифесты: слой с зависимостями кэшируется, пока они не изменились.
COPY libs/contracts/package.json libs/contracts/
COPY libs/nest-kit/package.json libs/nest-kit/
COPY libs/outbox/package.json libs/outbox/
COPY apps/wallet-service/package.json apps/wallet-service/
COPY apps/payments-service/package.json apps/payments-service/
COPY apps/notifications-service/package.json apps/notifications-service/
RUN pnpm install --frozen-lockfile
COPY libs libs
COPY apps apps
RUN pnpm build
ARG SERVICE
RUN pnpm --filter "@pp/${SERVICE}" --prod deploy --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]
