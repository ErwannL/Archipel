# syntax=docker/dockerfile:1
# Build stage: compiles the server (tsc) and the UI (vite). No secret is used or copied.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Optional build secret `extra_ca`: a CA bundle for TLS-intercepting proxies. Never stored in a layer.
RUN --mount=type=secret,id=extra_ca \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
COPY fake-orqea ./fake-orqea
RUN npm run build

# Runtime stage: production dependencies + compiled output only, non-root user.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
# The role (api | worker | all) is chosen by compose `command`.
CMD ["node", "-e", "import('./dist/src/main.js').then((m) => m.main(process.env, 'all'))"]
