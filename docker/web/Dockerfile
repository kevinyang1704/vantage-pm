# Vantage — local-only web app (no collaboration, no server, no account).
#
# Build:  docker compose up --build      (from the repository root)
# Open:   http://localhost:8080
#
# Stage 1 builds the browser app with the exact Node/npm the repo pins and the
# locked dependencies. Stage 2 serves the static files with nginx and the
# headers the in-browser SQLite database needs (cross-origin isolation).
# All project data stays in the user's browser; this container stores nothing.

FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
RUN npm install -g npm@11.16.0 --no-fund --no-audit
COPY package.json package-lock.json ./
# No third-party lifecycle scripts (repo convention).
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY . .
# Plain production build: the collaboration flag is off, so the bundle has no
# collaboration code and never contacts a server.
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
