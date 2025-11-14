FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install pnpm and curl for health checks
RUN npm install -g pnpm && apk add --no-cache curl

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/capabilities ./packages/capabilities
COPY packages/discord ./packages/discord
COPY packages/sms ./packages/sms

# Install all workspace dependencies
RUN pnpm install --filter "@coachartie/discord" --filter "@coachartie/shared"

# Build shared package first
RUN pnpm --filter "@coachartie/shared" run build

# Build discord
RUN pnpm --filter "@coachartie/discord" run build

# Create data and logs directories and set ownership for node user
RUN mkdir -p /app/data /app/logs && \
    chown -R node:node /app

# Switch to non-root user (node user already exists in base image as UID 1000)
USER node

# Set working directory to discord package
WORKDIR /app/packages/discord

# Set environment variables
ENV NODE_ENV=production
ENV DISCORD_STATUS_FILE=/app/data/discord-status.json
ENV DISCORD_METRICS_FILE=/app/data/discord-metrics.json
ENV DISCORD_EVENTS_FILE=/app/data/discord-events.json
ENV DISCORD_PORT=47321
ENV LOGS_DIR=/app/logs

# Expose discord port
EXPOSE 47321

# Health check - Discord gateway is the health indicator
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD test -f /app/data/discord-status.json && grep -q '"status": "ready"' /app/data/discord-status.json || exit 1

# Start the application with built code
CMD ["pnpm", "start"]