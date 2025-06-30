# Coach Artie 2 - A Deep Dive

This document provides a comprehensive, in-depth guide to the Coach Artie 2 monorepo. It is intended to be the single source of truth for understanding the architecture, services, and operational flow of the entire system.

> **📄 License**: This project is licensed for non-commercial use. For business inquiries, [commercial licenses are available](#-license--commercial-use).

---

## 🎯 MCP Tool Syntax (CRITICAL)

When calling MCP tools, **ALWAYS** use this simple syntax:

```xml
<!-- Search Wikipedia -->
<search-wikipedia>Python programming language</search-wikipedia>

<!-- Get Wikipedia article with optional params -->
<get-wikipedia-article limit="5">Python (programming language)</get-wikipedia-article>

<!-- Get current time (no args) -->
<get-current-time />

<!-- Parse a date -->
<parse-date>2025-06-30</parse-date>
```

**Rules:**
- Tool name = XML tag name (kebab-case like `search-wikipedia`)
- Main argument = tag content
- Optional params = XML attributes
- No args = self-closing tag
- **DO NOT** use the old format: `<capability name="mcp_client" action="call_tool"...>`

---

## 1. Core Philosophy & Architecture

Coach Artie 2 is designed as a modular, resilient, and extensible AI assistant platform. Its architecture is built on several key principles:

-   **Microservices:** The system is broken down into independent services (packages) that handle specific domains: AI logic, Discord communication, SMS, etc. This separation of concerns makes the system easier to develop, debug, and scale.
-   **Asynchronous Communication:** Services do not call each other directly. Instead, they communicate via a central **Redis message queue (using BullMQ)**. This decouples the services, ensuring that the failure of one component does not bring down the entire system. For example, the `discord` service simply publishes a message to a queue; it doesn't know or care how it gets processed.
-   **Centralized AI Orchestration:** A single service, `packages/capabilities`, acts as the brain. It consumes messages from all other services, orchestrates interactions with AI models, executes "capabilities" (tools), and publishes responses back to the appropriate queue.
-   **Infrastructure as Code:** The entire production environment is defined in code using Docker (`docker/`) and Docker Compose. This ensures consistency between development and production and simplifies deployment.
-   **Extensibility via MCP:** The system can connect to external **Model-Context-Protocol (MCP)** servers (`mcp-servers/`) to dynamically add new tools and capabilities without modifying the core services.

### System Flow Diagram

```
[User Interfaces]      [Message Queues]      [Core Logic]         [AI/Tools]
(Discord, SMS, etc)         (Redis)          (Capabilities Svc)
       |                      |                      |                    |
       | --- (publishes) ---> | INCOMING_MESSAGES    |                    |
       |                      | --- (consumes) ----> | Orchestrator       |
       |                      |                      | --- (requests) --> | (OpenRouter)
       |                      |                      |                    | (Wolfram, etc)
       |                      |                      | <--- (executes) -- | (Capabilities)
       |                      | <--- (publishes) --- | OUTGOING_QUEUES    |
       | <--- (consumes) ---- |                      |                    |
       |                      |                      |                    |
```

---

## 2. Getting Started

### Local Development (`pnpm` + `tsx`)

**Prerequisites:**
*   Node.js (v20+)
*   `pnpm` (v8+)
*   A local Redis server running.

**Steps:**
1.  `pnpm install` - Installs all dependencies for all packages.
2.  `cp .env.example .env` - Create a local environment file.
3.  Fill in your API keys in the new `.env` file.
4.  `pnpm run dev` - Starts all services concurrently using `tsx` for hot-reloading. Logs are aggregated to `/tmp/turbo.log`.

### Production Deployment (`Docker`)

The recommended method for production is using the provided Docker setup.

**Steps:**
1.  **Install Docker:**
    ```bash
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER && logout
    ```
2.  **Clone and Configure:**
    ```bash
    git clone https://github.com/room302studio/coachartie2.git && cd coachartie2
    cp .env.production .env
    nano .env # Add your production API keys
    ```
3.  **Deploy:**
    ```bash
    ./scripts/deploy-local.sh
    ```
    This script automates copying the `.env` file to the `docker/` directory and starts the services using `docker-compose`.

---

## 3. In-Depth Package Breakdown

This section details the purpose and inner workings of each package within the `packages/` directory.

### `packages/capabilities` - The Brain

This is the most critical service. It listens for jobs on the `INCOMING_MESSAGES` queue and orchestrates the entire response generation process.

-   **`src/index.ts`**: The main entry point. It starts the Express server (for health checks and direct API interaction) and initializes the queue consumer.
-   **`src/queues/consumer.ts`**: The heart of the service. It creates a BullMQ worker that listens to the `INCOMING_MESSAGES` queue. When a message arrives, it passes it to `src/handlers/process-message.ts`.
-   **`src/handlers/process-message.ts`**: This handler decides the main workflow. It calls the `CapabilityOrchestrator` to handle the message.
-   **`src/services/capability-orchestrator.ts`**: This is the central nervous system.
    1.  It takes the user's message and sends it to an AI model (via `openrouter.ts`) to get an initial response. This response may contain XML-like `<capability>` tags.
    2.  It uses the `xml-parser.ts` utility to extract any capabilities from both the user's original message and the AI's response.
    3.  It uses the `conscience.ts` service to review potentially dangerous operations (like file deletion) before execution.
    4.  It executes the extracted capabilities in sequence using the `capability-registry.ts`.
    5.  It takes the results of the executed capabilities and sends them *back* to the AI model to generate a final, coherent, natural-language response.
    6.  The final response is returned to the queue consumer, which then places it on the appropriate outgoing queue (e.g., `OUTGOING_DISCORD`).
-   **`src/services/capability-registry.ts`**: A plugin system for "tools." All available capabilities are registered here. This allows for easy addition of new tools without modifying the orchestrator.
-   **`src/capabilities/*.ts`**: Each file in this directory defines a specific capability (e.g., `calculator.ts`, `memory.ts`, `filesystem.ts`). Each capability exports a `RegisteredCapability` object that defines its name, supported actions, and handler function.
-   **`src/services/prompt-manager.ts`**: Manages loading and caching of system prompts from the SQLite database (`data/coachartie.db`). This allows for hot-reloading of prompts without restarting the service.
-   **`src/mcp-server.ts`**: Exposes the registered capabilities over the Model-Context-Protocol, allowing other applications (like a desktop client) to use Coach Artie's tools.

### `packages/discord` - The Discord Interface

This service connects to Discord and acts as a bridge to the Redis queues.

-   **`src/index.ts`**: Entry point. Initializes the Discord.js client and sets up listeners.
-   **`src/handlers/message-handler.ts`**: Handles the `MessageCreate` event from Discord. It determines if the bot should respond (e.g., if it was mentioned or is in a DM). It then calls...
-   **`src/queues/publisher.ts`**: This takes the message from Discord and publishes it to the `INCOMING_MESSAGES` Redis queue for the `capabilities` service to process.
-   **`src/queues/consumer.ts`**: This service also has a consumer that listens to the `OUTGOING_DISCORD` queue. When a final response arrives from the `capabilities` service, this consumer takes the message and sends it to the appropriate Discord channel.

### `packages/sms` - The Twilio SMS Interface

This service exposes an HTTP endpoint for Twilio to send incoming SMS messages.

-   **`src/index.ts`**: Starts an Express server.
-   **`src/routes/sms.ts`**: Defines the `/sms/webhook` endpoint that Twilio calls.
-   **`src/handlers/incoming-sms.ts`**: The handler for the webhook. It receives the SMS data, formats it into a standard `IncomingMessage` object, and publishes it to the `INCOMING_MESSAGES` queue.
-   **`src/queues/consumer.ts`**: Listens on the `OUTGOING_SMS` queue for responses from the `capabilities` service and uses the Twilio client (`src/utils/twilio.ts`) to send the reply.

### `packages/email` - The Email Interface

(Note: This package is less developed than others.)
-   **`src/index.ts`**: Starts the service.
-   **`src/handlers/incoming-email.ts`**: Intended to process incoming emails (e.g., from a webhook or mail server).

### `packages/shared` - Shared Code

This is a crucial internal library that contains code shared across all services to avoid duplication.
-   **`src/types/queue.ts`**: Defines the core `IncomingMessage` and `OutgoingMessage` TypeScript interfaces, ensuring consistent data structures across the system.
-   **`src/utils/redis.ts`**: Provides a singleton `createRedisConnection` function used by all services to connect to Redis.
-   **`src/utils/logger.ts`**: The shared `pino` logger configuration.
-   **`src/utils/database.ts`**: Provides access to the shared SQLite database.
-   **`src/constants/queues.ts`**: Defines the names of all Redis queues as constants.

---

## 4. Standalone MCP Servers (`mcp-servers/`)

This directory contains independent, standalone servers that provide additional tools via the Model-Context-Protocol (MCP). The core `capabilities` service can connect to these servers (using the `mcp-client` capability) to extend its functionality on the fly.

-   **`filesystem/`**: Provides tools for file system operations.
-   **`weather_openmeteo/`**: Provides weather forecasts using the Open-Meteo API.
-   **`custom/ascii-art-generator/`**: A user-created server for generating ASCII art.

Each server has its own `package.json` and can be run independently. They are typically started with a `./start.sh` script or `npm start`.

---

## 5. Configuration Deep Dive

-   **`pnpm-workspace.yaml`**: Defines the monorepo structure for `pnpm`. It tells `pnpm` where to find the different packages.
-   **`turbo.json`**: Configures Turborepo's build pipeline. It defines dependencies between packages (e.g., `shared` must be built before other packages) and sets up caching for faster builds.
-   **`tsconfig.json`**: The root TypeScript configuration. Each package extends this with its own specific settings, defining its output directory (`dist`) and package references.
-   **`.env.*` files**:
    -   `.env.example`: A template showing all possible environment variables.
    -   `.env`: Used for local development with `pnpm run dev`. **Not committed to git.**
    -   `.env.production`: A template for production. The `deploy-local.sh` script copies this to `.env` for Docker to use.
-   **`eslint.config.mjs`**: The configuration for ESLint, defining code style and quality rules for the entire project.

---

## 6. License & Commercial Use

**Non-Commercial License**: This project is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License. This allows for personal use, educational purposes, and non-profit work.

**Commercial Licensing**: For any business or revenue-generating use case, a commercial license is required. Please contact **Room 302 Studio** for licensing options.
-   **Email**: ejfox@room302.studio
-   **Website**: room302.studio
