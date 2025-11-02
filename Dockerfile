FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install pnpm and curl
RUN npm install -g pnpm && apk add --no-cache curl

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY packages/capabilities/package.json ./packages/capabilities/

# Install all workspace dependencies
RUN pnpm install --filter "@coachartie/capabilities" --filter "@coachartie/shared"

# Build shared package first
RUN pnpm --filter "@coachartie/shared" run build

# Copy capabilities source
COPY packages/capabilities ./packages/capabilities

# Set working directory to capabilities package
WORKDIR /app/packages/capabilities

# Build TypeScript to ensure compilation succeeds
RUN pnpm build

# Create data directory
RUN mkdir -p /app/data

# Expose the ports (health and API)
EXPOSE 47319 47324

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:47319/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/coachartie.db
ENV CAPABILITIES_PORT=47324

# Start the application with built code
CMD ["pnpm", "start"]
