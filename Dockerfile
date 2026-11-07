# Один Dockerfile на все сервисы: docker build --build-arg SERVICE=wallet-service .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY libs libs
COPY apps apps
RUN pnpm install --frozen-lockfile && pnpm build
ARG SERVICE
RUN pnpm --filter "@pp/${SERVICE}" --prod deploy --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]
