import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { capabilityRegistry } from '../services/capability-registry.js';
import { join, resolve } from 'path';
import { readFile as fsReadFile, writeFile as fsWriteFile, access, mkdir, constants } from 'fs/promises';
import { spawn } from 'child_process';

interface MCPTemplate {
  name: string;
  version: string;
  description: string;
  envVars: readonly string[];
  configFile: string;
  startScript: string;
  requiredPorts: readonly number[];
  verified: boolean;
  isNpxPackage?: boolean;
}

interface MCPInstallerParams {
  action: string;
  template?: string;
  name?: string;
  path?: string;
  install_path?: string;
  description?: string;
  port?: string;
  mcp_name?: string;
  env_vars?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  // New GitHub installation params
  url?: string;
  github_url?: string;
  repo_url?: string;
  git_url?: string;
}

interface HelloArgs {
  name?: string;
}

interface StatusArgs {
  [key: string]: unknown;
}

interface MCPHandlerResult {
  content: Array<{
    type: string;
    text: string;
  }>;
}

/**
 * MCP (Model Context Protocol) Installer Capability - The Master MCP Installation Orchestrator
 * 
 * This is the autonomous master capability that orchestrates the entire MCP installation process
 * by combining filesystem, package management, and environment management capabilities.
 * 
 * Supported actions:
 * - install_from_template: Install MCP from built-in templates (wolfram, weather, etc.)
 * - create_custom_mcp: Create a new MCP server from scratch
 * - setup_environment: Set up API keys and environment variables
 * - start_mcp_server: Start an installed MCP server
 * - check_mcp_status: Check if MCP servers are running
 * 
 * Features:
 * - Template-based installation for common MCPs
 * - Autonomous environment setup
 * - Complete workflow orchestration
 * - Error handling and rollback
 * - Status monitoring
 */

// Get the project root directory
const PROJECT_ROOT = resolve(process.cwd(), '../..');

// Built-in MCP templates with real, working npm packages
const MCP_TEMPLATES = {
  filesystem: {
    name: '@modelcontextprotocol/server-filesystem',
    version: 'latest',
    description: 'Official Filesystem MCP Server for file operations',
    envVars: [],
    configFile: 'filesystem-mcp-config.json',
    startScript: 'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
    requiredPorts: [3001],
    verified: true
  },
  postgres: {
    name: '@modelcontextprotocol/server-postgres',
    version: 'latest',
    description: 'Official PostgreSQL MCP Server for database operations',
    envVars: ['POSTGRES_CONNECTION_STRING'],
    configFile: 'postgres-mcp-config.json',
    startScript: 'node_modules/@modelcontextprotocol/server-postgres/dist/index.js',
    requiredPorts: [3002],
    verified: true
  },
  puppeteer: {
    name: '@modelcontextprotocol/server-puppeteer',
    version: 'latest',
    description: 'Official Puppeteer MCP Server for browser automation and web scraping',
    envVars: [],
    configFile: 'puppeteer-mcp-config.json',
    startScript: 'node_modules/@modelcontextprotocol/server-puppeteer/dist/index.js',
    requiredPorts: [3003],
    verified: true
  },
  weather: {
    name: '@rehmatalisayany/weather-mcp-server',
    version: 'latest',
    description: 'Weather MCP Server using Open Meteo API (no API key required)',
    envVars: [],
    configFile: 'weather-mcp-config.json',
    startScript: 'node_modules/@rehmatalisayany/weather-mcp-server/dist/index.js',
    requiredPorts: [3004],
    verified: true
  },
  github: {
    name: '@modelcontextprotocol/server-github',
    version: 'latest',
    description: 'Official GitHub MCP Server for repository management and deployment monitoring',
    envVars: ['GITHUB_TOKEN'],
    configFile: 'github-mcp-config.json',
    startScript: 'node_modules/@modelcontextprotocol/server-github/dist/index.js',
    requiredPorts: [3008],
    verified: true
  },
  brave_search: {
    name: '@modelcontextprotocol/server-brave-search',
    version: 'latest',
    description: 'Official Brave Search MCP Server for web search',
    envVars: ['BRAVE_API_KEY'],
    configFile: 'brave-search-mcp-config.json',
    startScript: 'node_modules/@modelcontextprotocol/server-brave-search/dist/index.js',
    requiredPorts: [3009],
    verified: true
  },
  wikipedia: {
    name: '@shelm/wikipedia-mcp-server',
    version: 'latest',
    description: 'Official Wikipedia MCP Server for encyclopedia searches and article retrieval',
    envVars: [],
    configFile: 'wikipedia-mcp-config.json',
    startScript: 'node_modules/@shelm/wikipedia-mcp-server/dist/index.js',
    requiredPorts: [3010],
    verified: true
  },
  linkedin: {
    name: 'mcp-linkedin',
    version: 'latest',
    description: 'LinkedIn MCP Server for feed posts, job search, and profile interactions',
    envVars: ['LINKEDIN_EMAIL', 'LINKEDIN_PASSWORD'],
    configFile: 'linkedin-mcp-config.json',
    startScript: 'uvx --from git+https://github.com/adhikasp/mcp-linkedin mcp-linkedin',
    requiredPorts: [3011],
    verified: true
  }
} as const;


type MCPTemplateName = keyof typeof MCP_TEMPLATES;

interface MCPInstallationResult {
  success: boolean;
  templateName?: string;
  packageName?: string;
  configPath?: string;
  environmentSetup?: boolean;
  serverStatus?: 'stopped' | 'starting' | 'running' | 'error';
  error?: string;
  port?: number;
}

/**
 * Install MCP from a built-in template with intelligent error handling and auto-retry
 */
async function installFromTemplate(templateName: string, installPath?: string): Promise<string> {
  if (!(templateName in MCP_TEMPLATES)) {
    // Try fuzzy matching for similar template names
    const availableTemplates = Object.keys(MCP_TEMPLATES);
    const suggestions = findSimilarTemplateNames(templateName, availableTemplates);
    
    if (suggestions.length > 0) {
      throw new Error(`❌ Unknown MCP template: "${templateName}". 
      
🔍 Did you mean: ${suggestions.slice(0, 3).join(', ')}?

📋 Available templates: ${availableTemplates.join(', ')}

💡 Try using one of the suggested templates above.`);
    }
    
    throw new Error(`❌ Unknown MCP template: "${templateName}". Available templates: ${availableTemplates.join(', ')}`);
  }

  const template = MCP_TEMPLATES[templateName as MCPTemplateName];
  const mcpPath = installPath || join(PROJECT_ROOT, 'mcp-servers', templateName);
  
  logger.info(`🚀 Installing MCP from template: ${templateName} at ${mcpPath}`);

  const result: MCPInstallationResult = {
    success: false,
    templateName,
    packageName: template.name
  };

  // Install the specified package
  const packagesToTry = [template.name];
  let lastError: Error | null = null;
  let attemptCount = 0;

  for (const packageName of packagesToTry) {
    attemptCount++;
    logger.info(`📦 Attempt ${attemptCount}: Trying package ${packageName}`);
    
    try {
      return await installMCPPackage(templateName, packageName, mcpPath, template, result);
    } catch (error) {
      lastError = error as Error;
      logger.warn(`⚠️  Package ${packageName} failed: ${lastError.message}`);
      
      // Analyze the error and provide intelligent suggestions
      const errorAnalysis = analyzeInstallationError(lastError, packageName);
      logger.info(`🔍 Error analysis: ${errorAnalysis.category} - ${errorAnalysis.suggestion}`);
      
      // Clean up failed attempt
      try {
        await capabilityRegistry.execute('filesystem', 'delete', { path: mcpPath, recursive: true });
        logger.info(`🧹 Cleaned up failed attempt for ${packageName}`);
      } catch (cleanupError) {
        logger.warn(`⚠️ Could not clean up after failed attempt:`, cleanupError);
      }
      
      // If this was a network/registry error and we have more packages to try, continue
      if (errorAnalysis.category === 'network' || errorAnalysis.category === 'package_not_found') {
        if (attemptCount < packagesToTry.length) {
          logger.info(`🔄 Retrying package installation...`);
          continue;
        }
      } else {
        // For other errors (permission, disk space, etc.), don't try other packages
        break;
      }
    }
  }

  // All packages failed
  const errorReport = generateDetailedErrorReport(templateName, packagesToTry, lastError, attemptCount);
  logger.error(`❌ All installation attempts failed for ${templateName}`);
  throw new Error(errorReport);
}

/**
 * Install a specific MCP package (extracted for reusability)
 */
async function installMCPPackage(
  templateName: string, 
  packageName: string, 
  mcpPath: string, 
  template: MCPTemplate, 
  result: MCPInstallationResult
): Promise<string> {
  try {
    // Step 1: Create MCP directory structure
    logger.info(`📁 Creating MCP directory structure at ${mcpPath}`);
    await capabilityRegistry.execute('filesystem', 'create_directory', { path: mcpPath });
    
    // Step 2: Initialize package.json
    logger.info(`📦 Initializing package.json for ${templateName} MCP`);
    const packageJsonOptions = {
      name: `coachartie-mcp-${templateName}`,
      version: '1.0.0',
      description: template.description,
      main: 'index.js',
      scripts: template.isNpxPackage ? {
        start: template.startScript,
        dev: template.startScript,
        install: 'npm install'
      } : {
        start: `node ${template.startScript}`,
        dev: `nodemon ${template.startScript}`,
        install: 'npm install'
      },
      dependencies: {},
      devDependencies: template.isNpxPackage ? {} : {
        nodemon: '^3.0.0'
      }
    };

    await capabilityRegistry.execute('package_manager', 'create_package', {
      package_path: mcpPath,
      options: packageJsonOptions
    });

    // Step 3: Install the MCP package (skip for npx packages)
    if (!template.isNpxPackage) {
      logger.info(`📥 Installing MCP package: ${packageName}`);
      await capabilityRegistry.execute('package_manager', 'install_package', {
        package_name: packageName,
        working_dir: mcpPath,
        dev: false
      });
    } else {
      logger.info(`📦 Using npx package: ${packageName} (no local installation needed)`);
    }

    // Step 4: Create MCP configuration file
    const configPath = join(mcpPath, template.configFile);
    const config = {
      name: templateName,
      description: template.description,
      version: template.version,
      port: template.requiredPorts[0],
      environment: template.envVars.reduce((acc: Record<string, string>, envVar: string) => {
        acc[envVar] = `\${${envVar}}`;
        return acc;
      }, {} as Record<string, string>),
      createdAt: new Date().toISOString(),
      installedBy: 'CoachArtie MCP Installer'
    };

    logger.info(`⚙️ Creating MCP configuration file: ${template.configFile}`);
    await capabilityRegistry.execute('filesystem', 'write_file', {
      path: configPath,
      content: JSON.stringify(config, null, 2)
    });

    result.configPath = configPath;

    // Step 5: Create environment file template if needed
    if (template.envVars.length > 0) {
      const envPath = join(mcpPath, '.env.example');
      const envContent = template.envVars.map((envVar: string) => {
        const description = getEnvVarDescription(envVar);
        return `# ${description}\n${envVar}=your_${envVar.toLowerCase()}_here`;
      }).join('\n\n');

      logger.info(`🔐 Creating environment template: .env.example`);
      await capabilityRegistry.execute('filesystem', 'write_file', {
        path: envPath,
        content: envContent + '\n'
      });
    }

    // Step 6: Create startup script
    const startupScript = `#!/bin/bash
# MCP Server Startup Script for ${templateName}
# Generated by CoachArtie MCP Installer

set -e

echo "🚀 Starting ${templateName} MCP Server..."

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v ^# | xargs)
    echo "✅ Environment variables loaded"
else
    echo "⚠️  No .env file found. Using system environment."
fi

# Check required environment variables
${template.envVars.map((envVar: string) => `
if [ -z "$${envVar}" ]; then
    echo "❌ Missing required environment variable: ${envVar}"
    exit 1
fi`).join('')}

# Start the MCP server
echo "🌟 Starting MCP server on port ${template.requiredPorts[0]}..."
exec node ${template.startScript}
`;

    const scriptPath = join(mcpPath, 'start.sh');
    await capabilityRegistry.execute('filesystem', 'write_file', {
      path: scriptPath,
      content: startupScript
    });

    // Make the script executable (using bash to set permissions)
    try {
      const { spawn } = require('child_process');
      await new Promise<void>((resolve, reject) => {
        const chmod = spawn('chmod', ['+x', scriptPath]);
        chmod.on('close', (code: number | null) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Failed to make script executable: exit code ${code}`));
          }
        });
        chmod.on('error', reject);
      });
    } catch (error) {
      logger.warn(`⚠️ Could not make startup script executable: ${error}`);
    }

    // Step 7: Create README
    const readme = `# ${templateName.toUpperCase()} MCP Server

${template.description}

## Installation

This MCP server has been automatically installed by CoachArtie.

## Configuration

- **Package**: ${template.name}
- **Port**: ${template.requiredPorts[0]}
- **Config File**: ${template.configFile}

## Environment Variables

${template.envVars.length > 0 ? template.envVars.map((envVar: string) => `- **${envVar}**: ${getEnvVarDescription(envVar)}`).join('\n') : 'No environment variables required.'}

## Usage

### Start the server
\`\`\`bash
npm start
# or
./start.sh
\`\`\`

### Development mode
\`\`\`bash
npm run dev
\`\`\`

## Setup

1. Copy \`.env.example\` to \`.env\`
2. Fill in your API keys and configuration
3. Run \`npm start\`

## Generated by CoachArtie MCP Installer
Created on: ${new Date().toISOString()}
`;

    await capabilityRegistry.execute('filesystem', 'write_file', {
      path: join(mcpPath, 'README.md'),
      content: readme
    });

    result.success = true;
    result.serverStatus = 'stopped';
    result.port = template.requiredPorts[0];

    logger.info(`✅ Successfully installed ${templateName} MCP at ${mcpPath}`);
    
    return `🎉 Successfully installed ${templateName} MCP server!

📁 Installation path: ${mcpPath}
📦 Package: ${packageName}
⚙️ Config file: ${template.configFile}
🚀 Port: ${template.requiredPorts[0]}

${template.envVars.length > 0 ? `🔐 Required environment variables:
${template.envVars.map((envVar: string) => `   - ${envVar}: ${getEnvVarDescription(envVar)}`).join('\n')}

📝 Next steps:
1. Copy .env.example to .env in the MCP directory
2. Fill in your API keys and configuration
3. Use the 'setup_environment' action to configure environment variables
4. Use the 'start_mcp_server' action to start the server` : '🚀 No environment setup required - you can start the server immediately!'}

💡 Use 'start_mcp_server' action with name="${templateName}" to start the server.`;

  } catch (error) {
    throw new Error(`Failed to install ${templateName} MCP: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Create a custom MCP server from scratch
 */
async function createCustomMCP(name: string, description?: string, port?: number): Promise<string> {
  const mcpPath = join(PROJECT_ROOT, 'mcp-servers', 'custom', name);
  const serverPort = port || 3100;
  
  logger.info(`🛠️ Creating custom MCP server: ${name} at ${mcpPath}`);

  try {
    // Step 1: Create directory structure
    await capabilityRegistry.execute('filesystem', 'create_directory', { path: mcpPath });
    await capabilityRegistry.execute('filesystem', 'create_directory', { path: join(mcpPath, 'src') });

    // Step 2: Create package.json
    await capabilityRegistry.execute('package_manager', 'create_package', {
      package_path: mcpPath,
      options: {
        name: `coachartie-mcp-${name}`,
        version: '1.0.0',
        description: description || `Custom MCP server: ${name}`,
        main: 'dist/index.js',
        scripts: {
          build: 'tsc',
          start: 'node dist/index.js',
          dev: 'ts-node src/index.ts',
          watch: 'tsc --watch'
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^0.5.0'
        },
        devDependencies: {
          '@types/node': '^20.0.0',
          'typescript': '^5.0.0',
          'ts-node': '^10.0.0'
        }
      }
    });

    // Step 3: Create TypeScript config
    const tsConfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        lib: ['ES2020'],
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist']
    };

    await capabilityRegistry.execute('filesystem', 'write_file', {
      path: join(mcpPath, 'tsconfig.json'),
      content: JSON.stringify(tsConfig, null, 2)
    });

    // Step 4: Create MCP server template
    const serverTemplate = `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Custom MCP Server: ${name}
 * ${description || 'Generated by CoachArtie MCP Installer'}
 * 
 * This is a template MCP server. Customize it for your needs.
 */

class ${name.charAt(0).toUpperCase() + name.slice(1)}MCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: '${name}-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'hello',
            description: 'Say hello - example tool',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Name to greet',
                },
              },
              required: ['name'],
            },
          },
          {
            name: 'status',
            description: 'Get server status',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'hello':
            return await this.handleHello(args);
          case 'status':
            return await this.handleStatus(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              \`Unknown tool: \${name}\`
            );
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          \`Tool execution failed: \${error instanceof Error ? error.message : String(error)}\`
        );
      }
    });
  }

  private async handleHello(args: HelloArgs): Promise<MCPHandlerResult> {
    const name = args.name || 'World';
    return {
      content: [
        {
          type: 'text',
          text: \`Hello, \${name}! This is the ${name} MCP server.\`,
        },
      ],
    };
  }

  private async handleStatus(args: StatusArgs): Promise<MCPHandlerResult> {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            server: '${name}-mcp-server',
            status: 'running',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
          }, null, 2),
        },
      ],
    };
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// Start the server
async function main() {
  try {
    const server = new ${name.charAt(0).toUpperCase() + name.slice(1)}MCPServer();
    await server.start();
  } catch (error) {
    console.error('❌ Failed to start ${name} MCP server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { ${name.charAt(0).toUpperCase() + name.slice(1)}MCPServer };
`;

    await capabilityRegistry.execute('filesystem', 'write_file', {
      path: join(mcpPath, 'src', 'index.ts'),
      content: serverTemplate
    });

    // Step 5: Create configuration file
    const config = {
      name,
      description: description || `Custom MCP server: ${name}`,
      version: '1.0.0',
      port: serverPort,
      type: 'custom',
      createdAt: new Date().toISOString(),
      installedBy: 'CoachArtie MCP Installer'
    };

    await capabilityRegistry.execute('filesystem', 'write_file', {
      path: join(mcpPath, 'mcp-config.json'),
      content: JSON.stringify(config, null, 2)
    });

    // Step 6: Create README
    const readme = `# ${name.toUpperCase()} MCP Server

${description || 'Custom MCP server generated by CoachArtie'}

## Installation

This MCP server has been automatically created by CoachArtie.

## Development

\`\`\`bash
# Install dependencies
npm install

# Build the server
npm run build

# Start the server
npm start

# Development mode (with auto-reload)
npm run dev
\`\`\`

## Customization

Edit \`src/index.ts\` to add your custom tools and functionality.

## Configuration

- **Port**: ${serverPort}
- **Config File**: mcp-config.json

## Generated by CoachArtie MCP Installer
Created on: ${new Date().toISOString()}
`;

    await capabilityRegistry.execute('filesystem', 'write_file', {
      path: join(mcpPath, 'README.md'),
      content: readme
    });

    // Step 7: Install dependencies
    logger.info(`📥 Installing dependencies for custom MCP server`);
    await capabilityRegistry.execute('package_manager', 'install_package', {
      package_name: '@modelcontextprotocol/sdk',
      working_dir: mcpPath,
      dev: false
    });

    await capabilityRegistry.execute('package_manager', 'install_package', {
      package_name: 'typescript',
      working_dir: mcpPath,
      dev: true
    });

    await capabilityRegistry.execute('package_manager', 'install_package', {
      package_name: 'ts-node',
      working_dir: mcpPath,
      dev: true
    });

    await capabilityRegistry.execute('package_manager', 'install_package', {
      package_name: '@types/node',
      working_dir: mcpPath,
      dev: true
    });

    logger.info(`✅ Successfully created custom MCP server: ${name}`);
    
    return `🎉 Successfully created custom MCP server: ${name}!

📁 Installation path: ${mcpPath}
⚙️ Config file: mcp-config.json
🚀 Port: ${serverPort}

📝 Next steps:
1. Edit src/index.ts to add your custom tools and functionality
2. Run 'npm run build' to compile the TypeScript
3. Use the 'start_mcp_server' action to start the server

💡 The server includes example tools ('hello' and 'status') to get you started.
💡 Use 'start_mcp_server' action with name="${name}" to start the server.`;

  } catch (error) {
    logger.error(`❌ Failed to create custom MCP server ${name}:`, error);
    
    // Attempt cleanup on failure
    try {
      await capabilityRegistry.execute('filesystem', 'delete', { path: mcpPath, recursive: true });
      logger.info(`🧹 Cleaned up failed installation at ${mcpPath}`);
    } catch (cleanupError) {
      logger.warn(`⚠️ Could not clean up failed installation:`, cleanupError);
    }
    
    throw new Error(`Failed to create custom MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Set up environment variables for an MCP server
 */
async function setupEnvironment(mcpName: string, envVars: Record<string, string>): Promise<string> {
  const mcpPath = join(PROJECT_ROOT, 'mcp-servers', mcpName);
  
  logger.info(`🔐 Setting up environment for MCP: ${mcpName}`);

  try {
    // Check if MCP exists
    const mcpExists = await capabilityRegistry.execute('filesystem', 'exists', { path: mcpPath });
    if (!mcpExists.includes('directory exists')) {
      throw new Error(`MCP server '${mcpName}' not found at ${mcpPath}`);
    }

    // Create .env file
    const envPath = join(mcpPath, '.env');
    Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    await capabilityRegistry.execute('environment', 'create_env_file', {
      file: envPath,
      variables: envVars
    });

    logger.info(`✅ Environment variables set for ${mcpName}`);
    
    return `🔐 Successfully set up environment for ${mcpName} MCP server!

📁 Environment file: ${envPath}
🔑 Variables configured: ${Object.keys(envVars).join(', ')}

✨ The MCP server is now ready to start with proper environment configuration.`;

  } catch (error) {
    logger.error(`❌ Failed to setup environment for ${mcpName}:`, error);
    throw new Error(`Failed to setup environment for ${mcpName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Start an MCP server
 */
async function startMCPServer(mcpName: string): Promise<string> {
  const mcpPath = join(PROJECT_ROOT, 'mcp-servers', mcpName);
  
  logger.info(`🚀 Starting MCP server: ${mcpName}`);

  try {
    // Check if MCP exists
    const mcpExists = await capabilityRegistry.execute('filesystem', 'exists', { path: mcpPath });
    if (!mcpExists.includes('directory exists')) {
      // Check if it's a custom MCP
      const customMcpPath = join(PROJECT_ROOT, 'mcp-servers', 'custom', mcpName);
      const customExists = await capabilityRegistry.execute('filesystem', 'exists', { path: customMcpPath });
      if (customExists.includes('directory exists')) {
        return await startCustomMCPServer(mcpName, customMcpPath);
      }
      throw new Error(`MCP server '${mcpName}' not found. Available templates: ${Object.keys(MCP_TEMPLATES).join(', ')}`);
    }

    // Check if there's a startup script
    const startupScriptPath = join(mcpPath, 'start.sh');
    const scriptExists = await capabilityRegistry.execute('filesystem', 'exists', { path: startupScriptPath });
    
    if (scriptExists.includes('file exists')) {
      // Use the startup script
      const { spawn } = require('child_process');
      
      return new Promise((resolve, reject) => {
        const startProcess = spawn('bash', [startupScriptPath], {
          cwd: mcpPath,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let errorOutput = '';

        startProcess.stdout?.on('data', (_data: Buffer) => {
          // Capture stdout but don't store it
        });

        startProcess.stderr?.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });

        // Don't wait for the process to end, just check if it starts successfully
        setTimeout(() => {
          if (startProcess.pid) {
            startProcess.unref(); // Allow the process to run independently
            resolve(`🚀 Successfully started ${mcpName} MCP server!

🆔 Process ID: ${startProcess.pid}
📁 Working directory: ${mcpPath}
📝 Startup script: start.sh

✨ The server is now running in the background.
💡 Use 'check_mcp_status' to monitor the server status.`);
          } else {
            reject(new Error(`Failed to start MCP server: ${errorOutput || 'Unknown error'}`));
          }
        }, 2000);

        startProcess.on('error', (error: Error) => {
          reject(new Error(`Failed to start MCP server: ${error.message}`));
        });
      });
    } else {
      // Use npm start
      const { spawn } = require('child_process');
      
      return new Promise((resolve, reject) => {
        const startProcess = spawn('npm', ['start'], {
          cwd: mcpPath,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let errorOutput = '';

        startProcess.stdout?.on('data', (_data: Buffer) => {
          // Capture stdout but don't store it
        });

        startProcess.stderr?.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });

        // Don't wait for the process to end, just check if it starts successfully
        setTimeout(() => {
          if (startProcess.pid) {
            startProcess.unref(); // Allow the process to run independently
            resolve(`🚀 Successfully started ${mcpName} MCP server!

🆔 Process ID: ${startProcess.pid}
📁 Working directory: ${mcpPath}
📝 Command: npm start

✨ The server is now running in the background.
💡 Use 'check_mcp_status' to monitor the server status.`);
          } else {
            reject(new Error(`Failed to start MCP server: ${errorOutput || 'Unknown error'}`));
          }
        }, 3000);

        startProcess.on('error', (error: Error) => {
          reject(new Error(`Failed to start MCP server: ${error.message}`));
        });
      });
    }

  } catch (error) {
    logger.error(`❌ Failed to start MCP server ${mcpName}:`, error);
    throw new Error(`Failed to start MCP server ${mcpName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Start a custom MCP server
 */
async function startCustomMCPServer(mcpName: string, mcpPath: string): Promise<string> {
  logger.info(`🛠️ Starting custom MCP server: ${mcpName}`);

  try {
    // Check if it's built
    const distExists = await capabilityRegistry.execute('filesystem', 'exists', { path: join(mcpPath, 'dist') });
    
    if (!distExists.includes('directory exists')) {
      // Build the TypeScript project first
      logger.info(`🔨 Building custom MCP server: ${mcpName}`);
      await capabilityRegistry.execute('package_manager', 'run_script', {
        script_name: 'build',
        working_dir: mcpPath
      });
    }

    // Start the server
    const { spawn } = require('child_process');
    
    return new Promise((resolve, reject) => {
      const startProcess = spawn('npm', ['start'], {
        cwd: mcpPath,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let errorOutput = '';

      startProcess.stdout?.on('data', (_data: Buffer) => {
        // Capture stdout but don't store it
      });

      startProcess.stderr?.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      // Don't wait for the process to end, just check if it starts successfully
      setTimeout(() => {
        if (startProcess.pid) {
          startProcess.unref(); // Allow the process to run independently
          resolve(`🚀 Successfully started custom ${mcpName} MCP server!

🆔 Process ID: ${startProcess.pid}
📁 Working directory: ${mcpPath}
🛠️ Type: Custom MCP Server
📝 Command: npm start

✨ The server is now running in the background.
💡 Use 'check_mcp_status' to monitor the server status.`);
        } else {
          reject(new Error(`Failed to start custom MCP server: ${errorOutput || 'Unknown error'}`));
        }
      }, 3000);

      startProcess.on('error', (error: Error) => {
        reject(new Error(`Failed to start custom MCP server: ${error.message}`));
      });
    });

  } catch (error) {
    logger.error(`❌ Failed to start custom MCP server ${mcpName}:`, error);
    throw new Error(`Failed to start custom MCP server ${mcpName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check MCP server status
 */
async function checkMCPStatus(): Promise<string> {
  logger.info(`🔍 Checking MCP server status`);

  try {
    const mcpServersPath = join(PROJECT_ROOT, 'mcp-servers');
    
    // Check if MCP servers directory exists
    const mcpDirExists = await capabilityRegistry.execute('filesystem', 'exists', { path: mcpServersPath });
    if (!mcpDirExists.includes('directory exists')) {
      return `📋 No MCP servers directory found. No MCP servers have been installed yet.

💡 Use 'install_from_template' to install a pre-built MCP server.
💡 Use 'create_custom_mcp' to create a custom MCP server.`;
    }

    // List installed MCP servers
    const mcpDirListing = await capabilityRegistry.execute('filesystem', 'list_directory', { path: mcpServersPath });
    
    if (mcpDirListing.includes('is empty')) {
      return `📋 MCP servers directory exists but is empty. No MCP servers have been installed yet.

💡 Use 'install_from_template' to install a pre-built MCP server.
💡 Use 'create_custom_mcp' to create a custom MCP server.`;
    }

    const statusReport: string[] = ['🔍 MCP Server Status Report', ''];

    // Parse directory listing to find MCP servers
    const entries = mcpDirListing.split('\n').filter(line => line.trim().startsWith('📁'));
    
    for (const entry of entries) {
      const serverName = entry.replace('📁 ', '').trim();
      if (serverName === 'custom') {
        // Handle custom servers
        const customPath = join(mcpServersPath, 'custom');
        const customListing = await capabilityRegistry.execute('filesystem', 'list_directory', { path: customPath });
        
        if (!customListing.includes('is empty')) {
          const customEntries = customListing.split('\n').filter(line => line.trim().startsWith('📁'));
          for (const customEntry of customEntries) {
            const customServerName = customEntry.replace('📁 ', '').trim();
            statusReport.push(`🛠️ Custom MCP Server: ${customServerName}`);
            statusReport.push(`   📁 Path: ${join(customPath, customServerName)}`);
            statusReport.push(`   🔧 Type: Custom TypeScript MCP Server`);
            statusReport.push('');
          }
        }
      } else {
        // Regular template-based server
        const serverPath = join(mcpServersPath, serverName);
        const configPath = join(serverPath, `${serverName}-mcp-config.json`);
        
        statusReport.push(`📦 Template MCP Server: ${serverName}`);
        statusReport.push(`   📁 Path: ${serverPath}`);
        
        // Try to read config
        try {
          const configExists = await capabilityRegistry.execute('filesystem', 'exists', { path: configPath });
          if (configExists.includes('file exists')) {
            const configContent = await capabilityRegistry.execute('filesystem', 'read_file', { path: configPath });
            const config = JSON.parse(configContent.split('\n').slice(1).join('\n')); // Remove the first line which is the file path
            statusReport.push(`   🚀 Port: ${config.port}`);
            statusReport.push(`   📄 Description: ${config.description}`);
          }
        } catch {
          statusReport.push(`   ⚠️  Could not read configuration`);
        }
        
        statusReport.push('');
      }
    }

    // Check for running processes (basic check)
    statusReport.push('🔄 Process Status:');
    statusReport.push('   💡 Use system process monitoring tools to check if MCP servers are running');
    statusReport.push('   💡 MCP servers typically run as background processes after starting');

    statusReport.push('');
    statusReport.push('📝 Available Actions:');
    statusReport.push('   • Use "start_mcp_server" to start a specific MCP server');
    statusReport.push('   • Use "setup_environment" to configure API keys and environment variables');
    statusReport.push('   • Use "install_from_template" to install more MCP servers');

    return statusReport.join('\n');

  } catch (error) {
    logger.error(`❌ Failed to check MCP status:`, error);
    throw new Error(`Failed to check MCP status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get description for environment variables
 */
function getEnvVarDescription(envVar: string): string {
  const descriptions: Record<string, string> = {
    'WOLFRAM_ALPHA_APPID': 'Your Wolfram Alpha API App ID (get from developer.wolframalpha.com)',
    'WEATHER_API_KEY': 'Your weather service API key (OpenWeatherMap, etc.)',
    'ACCUWEATHER_API_KEY': 'Your AccuWeather API key (get from developer.accuweather.com)',
    'GITHUB_TOKEN': 'Your GitHub personal access token with appropriate permissions',
    'POSTGRES_CONNECTION_STRING': 'PostgreSQL database connection string (postgresql://user:pass@host:port/db)',
  };

  return descriptions[envVar] || `Configuration value for ${envVar}`;
}

/**
 * Find similar template names using fuzzy matching
 */
function findSimilarTemplateNames(target: string, available: string[]): string[] {
  return available
    .map(name => ({ name, score: calculateStringSimilarity(target, name) }))
    .filter(item => item.score > 0.3) // Lower threshold for template names
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(item => item.name);
}

/**
 * Calculate string similarity (improved version for template matching)
 */
function calculateStringSimilarity(a: string, b: string): number {
  if (a === b) {return 1.0;}
  if (a.length === 0 || b.length === 0) {return 0.0;}
  
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  
  // Check for exact substring matches
  if (aLower.includes(bLower) || bLower.includes(aLower)) {return 0.9;}
  
  // Check for word-level matches (split by underscores, hyphens)
  const aWords = aLower.split(/[_-]/);
  const bWords = bLower.split(/[_-]/);
  
  let wordMatches = 0;
  for (const aWord of aWords) {
    for (const bWord of bWords) {
      if (aWord === bWord) {wordMatches++;}
      else if (aWord.includes(bWord) || bWord.includes(aWord)) {wordMatches += 0.5;}
    }
  }
  
  if (wordMatches > 0) {
    return Math.min(0.8, wordMatches / Math.max(aWords.length, bWords.length));
  }
  
  // Levenshtein distance-based similarity
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  
  for (let i = 0; i <= a.length; i++) {matrix[0][i] = i;}
  for (let j = 0; j <= b.length; j++) {matrix[j][0] = j;}
  
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,     // deletion
        matrix[j - 1][i] + 1,     // insertion
        matrix[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  
  const distance = matrix[b.length][a.length];
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * Analyze installation errors and provide intelligent suggestions
 */
function analyzeInstallationError(error: Error, packageName: string): { category: string; suggestion: string } {
  const errorMessage = error.message.toLowerCase();
  
  // Network/Registry errors
  if (errorMessage.includes('404') || errorMessage.includes('not found')) {
    return {
      category: 'package_not_found',
      suggestion: `Package "${packageName}" not found in registry. Please check the package name or network connection.`
    };
  }
  
  if (errorMessage.includes('network') || errorMessage.includes('timeout') || errorMessage.includes('enotfound')) {
    return {
      category: 'network',
      suggestion: 'Network connectivity issue. Check internet connection or try again later.'
    };
  }
  
  if (errorMessage.includes('unauthorized') || errorMessage.includes('forbidden')) {
    return {
      category: 'auth',
      suggestion: 'Authentication issue. Check npm credentials or use public packages.'
    };
  }
  
  // Disk/Permission errors
  if (errorMessage.includes('enospc') || errorMessage.includes('no space')) {
    return {
      category: 'disk_space',
      suggestion: 'Insufficient disk space. Free up space and try again.'
    };
  }
  
  if (errorMessage.includes('eacces') || errorMessage.includes('permission denied')) {
    return {
      category: 'permissions',
      suggestion: 'Permission denied. Check file/directory permissions or run with appropriate privileges.'
    };
  }
  
  // Version/Dependency errors
  if (errorMessage.includes('version') || errorMessage.includes('incompatible')) {
    return {
      category: 'version_conflict',
      suggestion: 'Version conflict detected. Try updating dependencies or using a different version.'
    };
  }
  
  if (errorMessage.includes('peer dep') || errorMessage.includes('missing dependency')) {
    return {
      category: 'dependency',
      suggestion: 'Missing dependencies. Installing required peer dependencies automatically.'
    };
  }
  
  // Registry/Mirror errors
  if (errorMessage.includes('registry') || errorMessage.includes('mirror')) {
    return {
      category: 'registry',
      suggestion: 'Registry issue. Try switching to a different npm registry or mirror.'
    };
  }
  
  // Default
  return {
    category: 'unknown',
    suggestion: 'Unknown error. Check logs for details and consider manual installation.'
  };
}

/**
 * Generate detailed error report for failed installations
 */
function generateDetailedErrorReport(
  templateName: string, 
  packagesAttempted: string[], 
  lastError: Error | null, 
  attemptCount: number
): string {
  const report = [`❌ Failed to install MCP template: "${templateName}"`];
  
  report.push('');
  report.push('🔍 **Diagnosis Report:**');
  report.push(`   • Attempts made: ${attemptCount}`);
  report.push(`   • Packages tried: ${packagesAttempted.join(', ')}`);
  
  if (lastError) {
    const analysis = analyzeInstallationError(lastError, packagesAttempted[packagesAttempted.length - 1]);
    report.push(`   • Error category: ${analysis.category}`);
    report.push(`   • Last error: ${lastError.message.split('\n')[0]}`);
  }
  
  report.push('');
  report.push('🛠️ **Possible Solutions:**');
  
  // Suggest alternatives based on template type
  if (templateName.includes('weather')) {
    report.push('   • Try a different weather template:');
    const weatherTemplates = Object.keys(MCP_TEMPLATES).filter(t => t.includes('weather'));
    weatherTemplates.forEach(template => {
      if (template !== templateName) {
        report.push(`     - ${template}: ${MCP_TEMPLATES[template as MCPTemplateName].description}`);
      }
    });
  }
  
  report.push('   • Check network connectivity and npm configuration');
  report.push('   • Verify npm registry access and authentication');
  report.push('   • Try creating a custom MCP server instead:');
  report.push('     `<capability name="mcp_installer" action="create_custom_mcp" name="my_weather_server" />`');
  
  report.push('');
  report.push('📋 **Available Templates:**');
  Object.keys(MCP_TEMPLATES).forEach(template => {
    const info = MCP_TEMPLATES[template as MCPTemplateName];
    const status = info.verified ? '✅' : '⚠️';
    report.push(`   ${status} ${template}: ${info.description}`);
  });
  
  return report.join('\n');
}

/**
 * MCP Installer capability handler
 */
async function handleMCPInstallerAction(params: MCPInstallerParams, content?: string): Promise<string> {
  const { action } = params;
  
  try {
    switch (action) {
      case 'install_from_template':
        return await handleInstallFromTemplate(params, content);
      
      case 'install_from_github':
        return await handleInstallFromGitHub(params, content);
      
      case 'create_custom_mcp':
        return await handleCreateCustomMCP(params, content);
      
      case 'setup_environment':
        return await handleSetupEnvironment(params, content);
      
      case 'start_mcp_server':
        return await handleStartMCPServer(params, content);
      
      case 'check_mcp_status':
        return await handleCheckMCPStatus(params, content);
      
      default:
        throw new Error(`Unknown MCP installer action: ${action}`);
    }
  } catch (error) {
    logger.error(`MCP installer capability error for action '${action}':`, error);
    throw error;
  }
}

/**
 * Handle install from template action
 */
async function handleInstallFromTemplate(params: MCPInstallerParams, _content?: string): Promise<string> {
  const templateName = params.template || params.name;
  const installPath = params.path || params.install_path;
  
  if (!templateName) {
    throw new Error(`Template name is required. Available templates: ${Object.keys(MCP_TEMPLATES).join(', ')}`);
  }

  return await installFromTemplate(templateName, installPath);
}

/**
 * Handle install from GitHub action
 */
async function handleInstallFromGitHub(params: MCPInstallerParams, _content?: string): Promise<string> {
  const githubUrl = params.url || params.github_url || params.repo_url || params.git_url;
  const installPath = params.path || params.install_path;
  
  if (!githubUrl) {
    throw new Error('GitHub URL is required for install_from_github action');
  }

  // Validate GitHub URL
  if (!isValidGitHubUrl(githubUrl)) {
    throw new Error(`Invalid GitHub URL: ${githubUrl}. Expected format: https://github.com/user/repo`);
  }

  return await installFromGitHub(githubUrl, installPath);
}

/**
 * Handle create custom MCP action
 */
async function handleCreateCustomMCP(params: MCPInstallerParams, content?: string): Promise<string> {
  const name = params.name;
  const description = params.description || content;
  const port = params.port ? parseInt(params.port) : undefined;
  
  if (!name) {
    throw new Error('MCP server name is required for create_custom_mcp action');
  }

  // Validate name
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('MCP server name must contain only letters, numbers, underscores, and hyphens');
  }

  return await createCustomMCP(name, description, port);
}

/**
 * Handle setup environment action
 */
async function handleSetupEnvironment(params: MCPInstallerParams, _content?: string): Promise<string> {
  const mcpName = params.mcp_name || params.name;
  const envVars = params.env_vars || params.environment || params.variables;
  
  if (!mcpName) {
    throw new Error('MCP server name is required for setup_environment action');
  }

  if (!envVars || typeof envVars !== 'object') {
    throw new Error('Environment variables object is required for setup_environment action');
  }

  // Convert unknown values to strings
  const stringEnvVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    stringEnvVars[key] = String(value);
  }
  
  return await setupEnvironment(mcpName, stringEnvVars);
}

/**
 * Handle start MCP server action
 */
async function handleStartMCPServer(params: MCPInstallerParams, _content?: string): Promise<string> {
  const mcpName = params.name || params.mcp_name;
  
  if (!mcpName) {
    throw new Error('MCP server name is required for start_mcp_server action');
  }

  return await startMCPServer(mcpName);
}

/**
 * Handle check MCP status action
 */
async function handleCheckMCPStatus(_params: MCPInstallerParams, _content?: string): Promise<string> {
  return await checkMCPStatus();
}

/**
 * Utility functions
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') {
      throw error;
    }
  }
}

async function readFile(filePath: string): Promise<string> {
  return await fsReadFile(filePath, 'utf-8');
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fsWriteFile(filePath, content, 'utf-8');
}

async function runCommand(
  command: string, 
  args: string[], 
  options: { cwd?: string } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`Command failed: ${command} ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`);
        reject(error);
      }
    });
    
    child.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Validate GitHub URL format
 */
function isValidGitHubUrl(url: string): boolean {
  const githubUrlPattern = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/;
  return githubUrlPattern.test(url);
}

/**
 * Extract repository info from GitHub URL
 */
function parseGitHubUrl(url: string): { owner: string; repo: string; fullName: string } {
  const match = url.match(/^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/?$/);
  if (!match) {
    throw new Error(`Could not parse GitHub URL: ${url}`);
  }
  
  const [, owner, repo] = match;
  return {
    owner,
    repo: repo.replace(/\.git$/, ''), // Remove .git suffix if present
    fullName: `${owner}/${repo.replace(/\.git$/, '')}`
  };
}

/**
 * Install MCP server from GitHub repository
 */
async function installFromGitHub(githubUrl: string, customInstallPath?: string): Promise<string> {
  logger.info(`🚀 Starting GitHub MCP installation from: ${githubUrl}`);
  
  const { repo, fullName } = parseGitHubUrl(githubUrl);
  const mcpServersPath = customInstallPath || join(process.cwd(), 'mcp-servers');
  const serverPath = join(mcpServersPath, repo);
  
  try {
    // Check if already installed
    if (await fileExists(serverPath)) {
      return `❌ MCP server '${repo}' is already installed at ${serverPath}. Use update action to refresh.`;
    }

    // Create mcp-servers directory if it doesn't exist
    await ensureDirectoryExists(mcpServersPath);
    
    // Clone the repository
    logger.info(`📥 Cloning repository ${fullName}...`);
    await runCommand('git', ['clone', githubUrl, serverPath]);
    
    // Check if it's actually an MCP server
    const mcpDetection = await detectMCPServer(serverPath);
    if (!mcpDetection.isMCP) {
      // Clean up the cloned repo
      await runCommand('rm', ['-rf', serverPath]);
      return `❌ Repository ${fullName} does not appear to be an MCP server. ${mcpDetection.reason}`;
    }
    
    logger.info(`✅ Detected MCP server: ${mcpDetection.description}`);
    
    // Install dependencies
    const packageJsonPath = join(serverPath, 'package.json');
    if (await fileExists(packageJsonPath)) {
      logger.info(`📦 Installing dependencies for ${repo}...`);
      await runCommand('npm', ['install'], { cwd: serverPath });
    }
    
    // Generate configuration
    const config = {
      name: repo,
      description: mcpDetection.description || `MCP server installed from ${fullName}`,
      version: 'latest',
      port: 3020 + Math.floor(Math.random() * 100), // Random port to avoid conflicts
      environment: {},
      githubUrl,
      installedBy: 'CoachArtie GitHub MCP Installer',
      createdAt: new Date().toISOString(),
      startCommand: mcpDetection.startCommand,
      protocol: 'stdio' // Default to stdio for GitHub MCPs
    };
    
    const configPath = join(serverPath, `${repo}-mcp-config.json`);
    await writeFile(configPath, JSON.stringify(config, null, 2));
    
    // Create start script
    const startScript = `#!/bin/bash
cd "${serverPath}"
${mcpDetection.startCommand}
`;
    const startScriptPath = join(serverPath, 'start.sh');
    await writeFile(startScriptPath, startScript);
    await runCommand('chmod', ['+x', startScriptPath]);
    
    logger.info(`🎉 Successfully installed MCP server '${repo}' from GitHub!`);
    
    return `✅ Successfully installed MCP server '${repo}' from GitHub repository ${fullName}!

📁 Installation path: ${serverPath}
📄 Configuration: ${configPath}
🚀 Start command: ${mcpDetection.startCommand}
📜 Description: ${mcpDetection.description}

The server is ready to use. You can start it with the 'start_mcp_server' action using name "${repo}".`;

  } catch (error) {
    logger.error(`❌ Failed to install MCP server from GitHub: ${error}`);
    
    // Clean up on failure
    if (await fileExists(serverPath)) {
      await runCommand('rm', ['-rf', serverPath]).catch(() => {
        // Ignore cleanup errors
      });
    }
    
    throw new Error(`Failed to install MCP server from GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Detect if a directory contains an MCP server
 */
async function detectMCPServer(serverPath: string): Promise<{
  isMCP: boolean;
  reason?: string;
  description?: string;
  startCommand?: string;
}> {
  const packageJsonPath = join(serverPath, 'package.json');
  const readmePath = join(serverPath, 'README.md');
  
  // Check package.json for MCP indicators
  if (await fileExists(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath));
      
      // Look for MCP-related keywords in dependencies or description
      const mcpKeywords = ['mcp', 'model-context-protocol', '@modelcontextprotocol'];
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      const hasMCPDeps = Object.keys(deps).some(dep => 
        mcpKeywords.some(keyword => dep.includes(keyword))
      );
      
      const description = packageJson.description || '';
      const hasMCPDescription = mcpKeywords.some(keyword => 
        description.toLowerCase().includes(keyword.toLowerCase())
      );
      
      if (hasMCPDeps || hasMCPDescription) {
        // Determine start command
        let startCommand = 'npm start';
        if (packageJson.scripts?.start) {
          startCommand = `npm start`;
        } else if (packageJson.main) {
          startCommand = `node ${packageJson.main}`;
        } else if (await fileExists(join(serverPath, 'dist', 'index.js'))) {
          startCommand = 'node dist/index.js';
        }
        
        return {
          isMCP: true,
          description: description || `MCP server: ${packageJson.name}`,
          startCommand
        };
      }
    } catch (error) {
      logger.warn(`Could not parse package.json: ${error}`);
    }
  }
  
  // Check README for MCP indicators
  if (await fileExists(readmePath)) {
    try {
      const readme = await readFile(readmePath);
      const mcpIndicators = [
        'model context protocol',
        'mcp server',
        '@modelcontextprotocol',
        'claude mcp',
        'mcp tools'
      ];
      
      if (mcpIndicators.some(indicator => 
        readme.toLowerCase().includes(indicator.toLowerCase())
      )) {
        return {
          isMCP: true,
          description: 'MCP server (detected from README)',
          startCommand: 'npm start'
        };
      }
    } catch (error) {
      logger.warn(`Could not read README: ${error}`);
    }
  }
  
  // Check for common MCP file patterns
  const mcpFiles = [
    'mcp.json',
    'mcp-config.json',
    'tools.json',
    'src/tools.ts',
    'src/server.ts'
  ];
  
  for (const mcpFile of mcpFiles) {
    if (await fileExists(join(serverPath, mcpFile))) {
      return {
        isMCP: true,
        description: `MCP server (detected ${mcpFile})`,
        startCommand: 'npm start'
      };
    }
  }
  
  return {
    isMCP: false,
    reason: 'No MCP indicators found in package.json, README.md, or common MCP files'
  };
}

/**
 * MCP Installer capability definition
 */
export const mcpInstallerCapability: RegisteredCapability = {
  name: 'mcp_installer',
  supportedActions: ['install_from_template', 'install_from_github', 'create_custom_mcp', 'setup_environment', 'start_mcp_server', 'check_mcp_status'],
  description: 'Autonomous MCP (Model Context Protocol) installation and management capability that orchestrates filesystem, package management, and environment setup',
  handler: handleMCPInstallerAction
};