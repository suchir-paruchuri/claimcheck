# One image for both backend processes. The API and the worker share all their code,
# so docker-compose.yml starts the same image with different commands.

# ---- build: compile TypeScript with dev dependencies available ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies and compiled JavaScript only ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run as the unprivileged user the Node image provides, not root.
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
