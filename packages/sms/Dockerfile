FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install pnpm and curl
RUN npm install -g pnpm && apk add --no-cache curl

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY packages/sms/package.json ./packages/sms/

# Install all workspace dependencies
RUN pnpm install --filter "@coachartie/sms" --filter "@coachartie/shared"

# Build shared package
RUN pnpm --filter "@coachartie/shared" run build

# Copy sms source
COPY packages/sms ./packages/sms

# Set working directory to sms package
WORKDIR /app/packages/sms

# Expose the port
EXPOSE 47326

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:47326/health || exit 1

# Set environment variables
ENV NODE_ENV=development
ENV SMS_PORT=47326

# Start the application
CMD ["pnpm", "dev"]