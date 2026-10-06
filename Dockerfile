# --- build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install deps against the lockfile first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies — keep only what runtime needs.
RUN npm prune --omit=dev

# --- runtime stage -----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the built-in unprivileged user.
USER node

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

# Default transport is stdio. For HTTP, set MCP_TRANSPORT=http, HOST=0.0.0.0
# and MCP_AUTH_TOKEN (see docker-compose.yml and README).
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
