FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Injected at build time via --build-arg BUILD_DATE="$(date ...)"
ARG BUILD_DATE
RUN test -n "$BUILD_DATE" && echo "$BUILD_DATE" > .git-commit-date || true
ENV PORT=3111
EXPOSE 3111
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3111/health || exit 1
USER node
CMD ["node", "server.js"]
