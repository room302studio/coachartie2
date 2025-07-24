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

# Copy discord source
COPY packages/discord ./packages/discord

# Create data directory for status file
RUN mkdir -p /app/data

# Set working directory to discord package
WORKDIR /app/packages/discord

# Set environment variables
ENV NODE_ENV=development

# Start the application
CMD ["pnpm", "dev"]