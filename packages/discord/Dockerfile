FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY packages/discord/package.json ./packages/discord/

# Install all workspace dependencies
RUN pnpm install --filter "@coachartie/discord" --filter "@coachartie/shared"

# Build shared package first
RUN pnpm --filter "@coachartie/shared" run build

# Copy discord source
COPY packages/discord ./packages/discord

# Create data directory for status file and telemetry
RUN mkdir -p /app/data

# Set working directory to discord package
WORKDIR /app/packages/discord

# Set environment variables
ENV NODE_ENV=development
ENV DISCORD_STATUS_FILE=/app/data/discord-status.json
ENV DISCORD_METRICS_FILE=/app/data/discord-metrics.json
ENV DISCORD_EVENTS_FILE=/app/data/discord-events.json
ENV HEALTH_PORT=3001

# Expose health check port
EXPOSE 3001

# Start the application
CMD ["pnpm", "dev"]