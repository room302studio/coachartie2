FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install pnpm and curl
RUN npm install -g pnpm && apk add --no-cache curl

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/irc ./packages/irc

# Install all workspace dependencies
RUN pnpm install --filter "@coachartie/irc" --filter "@coachartie/shared"

# Build shared package
RUN pnpm --filter "@coachartie/shared" run build

# Build irc
RUN pnpm --filter "@coachartie/irc" run build

# Set working directory to irc package
WORKDIR /app/packages/irc

# Create logs and data directories and set ownership for node user
RUN mkdir -p /app/logs /app/data && \
    chown -R node:node /app

# Switch to non-root user (node user already exists in base image as UID 1000)
USER node

# Expose the port
EXPOSE 47327

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:47327/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV IRC_PORT=47327
ENV LOGS_DIR=/app/logs

# Start the application with built code
CMD ["pnpm", "start"]
