FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install pnpm and curl
RUN npm install -g pnpm && apk add --no-cache curl

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/capabilities/package.json ./packages/capabilities/

# Install all workspace dependencies
RUN pnpm install --filter "@coachartie/capabilities" --filter "@coachartie/shared"

# Build shared package first
RUN pnpm --filter "@coachartie/shared" run build

# Copy capabilities source
COPY packages/capabilities ./packages/capabilities

# Build capabilities
RUN pnpm --filter "@coachartie/capabilities" run build

# Set working directory to capabilities package
WORKDIR /app/packages/capabilities

# Create data and logs directories and set ownership for node user
RUN mkdir -p /app/data /app/logs && \
    chown -R node:node /app

# Switch to non-root user (node user already exists in base image as UID 1000)
USER node

# Expose the port
EXPOSE 47324

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:47324/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/coachartie.db
ENV CAPABILITIES_PORT=47324
ENV LOGS_DIR=/app/logs

# Start the application with built code
CMD ["pnpm", "start"]