import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { mcpClientService } from './mcp-client.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, readFile } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

/**
 * GitHub repository information
 */
interface GitHubRepo {
  owner: string;
  repo: string;
  branch?: string;
  path?: string;
  url: string;
}

/**
 * MCP Server detection result
 */
interface MCPServerInfo {
  type: 'npm' | 'docker' | 'node' | 'python';
  command: string;
  args?: string[];
  detected: boolean;
  packageJson?: any;
  dockerfile?: boolean;
  requirements?: boolean;
}

/**
 * Auto-installer for MCP servers from various sources
 */
class MCPAutoInstaller {
  private tempDir = '/tmp/mcp-installs';

  /**
   * Parse GitHub URL into components
   */
  private parseGitHubUrl(url: string): GitHubRepo | null {
    const patterns = [
      /github\.com\/([^\/]+)\/([^\/]+)(?:\/(?:tree|blob)\/([^\/]+)(?:\/(.+))?)?/,
      /github\.com\/([^\/]+)\/([^\/]+)\.git/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return {
          owner: match[1],
          repo: match[2].replace(/\.git$/, ''),
          branch: match[3] || 'main',
          path: match[4],
          url,
        };
      }
    }

    return null;
  }

  /**
   * Detect if a GitHub repo contains an MCP server
   */
  private async detectMCPServer(repoPath: string): Promise<MCPServerInfo> {
    const result: MCPServerInfo = {
      type: 'node',
      command: '',
      detected: false,
    };

    try {
      // Check for package.json (Node.js)
      const packageJsonPath = join(repoPath, 'package.json');
      try {
        await access(packageJsonPath);
        const packageContent = await readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageContent);
        result.packageJson = packageJson;

        // Look for MCP-related keywords
        const mcpKeywords = ['mcp', 'model-context-protocol', 'anthropic'];
        const hasMcpKeywords =
          (packageJson.keywords &&
            packageJson.keywords.some((k: string) =>
              mcpKeywords.some((mk) => k.toLowerCase().includes(mk))
            )) ||
          (packageJson.description &&
            mcpKeywords.some((mk) => packageJson.description.toLowerCase().includes(mk))) ||
          (packageJson.dependencies &&
            Object.keys(packageJson.dependencies).some(
              (dep: string) => dep.includes('mcp') || dep.includes('model-context-protocol')
            ));

        if (hasMcpKeywords) {
          result.detected = true;
          result.type = 'npm';

          // Try to determine the start command
          if (packageJson.bin) {
            const binName =
              typeof packageJson.bin === 'string'
                ? packageJson.name
                : Object.keys(packageJson.bin)[0];
            result.command = `npx ${packageJson.name}`;
          } else if (packageJson.scripts?.start) {
            result.command = `npm run start`;
          } else if (packageJson.main) {
            result.command = `node ${packageJson.main}`;
          } else {
            result.command = `node index.js`;
          }
        }
      } catch (e) {
        // No package.json found
      }

      // Check for Dockerfile
      try {
        await access(join(repoPath, 'Dockerfile'));
        result.dockerfile = true;
        if (!result.detected) {
          result.type = 'docker';
          result.detected = true;
          result.command = 'docker';
          result.args = ['run', '-i', '--rm', '--init'];
        }
      } catch (e) {
        // No Dockerfile found
      }

      // Check for Python requirements
      try {
        await access(join(repoPath, 'requirements.txt'));
        result.requirements = true;
        if (!result.detected) {
          result.type = 'python';
          result.detected = true;
          result.command = 'python';
          result.args = ['main.py']; // Common convention
        }
      } catch (e) {
        // No requirements.txt found
      }

      // Check for common MCP files
      const mcpFiles = ['server.js', 'server.py', 'mcp-server.js', 'index.js'];
      for (const file of mcpFiles) {
        try {
          await access(join(repoPath, file));
          if (!result.detected) {
            result.detected = true;
            if (file.endsWith('.py')) {
              result.type = 'python';
              result.command = `python ${file}`;
            } else {
              result.type = 'node';
              result.command = `node ${file}`;
            }
          }
          break;
        } catch (e) {
          // File not found, continue
        }
      }
    } catch (error) {
      logger.error('Error detecting MCP server:', error);
    }

    return result;
  }

  /**
   * Clone a GitHub repository
   */
  private async cloneRepo(repo: GitHubRepo): Promise<string> {
    const repoDir = join(this.tempDir, `${repo.owner}-${repo.repo}-${Date.now()}`);

    logger.info(`Cloning ${repo.url} to ${repoDir}`);

    try {
      // Ensure temp directory exists
      await execAsync(`mkdir -p ${this.tempDir}`);

      // Clone the repository
      await execAsync(`git clone --depth 1 --branch ${repo.branch} ${repo.url} ${repoDir}`);

      // If specific path is requested, use that as the working directory
      if (repo.path) {
        const specificPath = join(repoDir, repo.path);
        try {
          await access(specificPath);
          return specificPath;
        } catch (e) {
          logger.warn(`Specified path ${repo.path} not found, using root`);
        }
      }

      return repoDir;
    } catch (error) {
      logger.error(`Failed to clone repository:`, error);
      throw new Error(`Failed to clone repository: ${error}`);
    }
  }

  /**
   * Install dependencies for an MCP server
   */
  private async installDependencies(repoPath: string, serverInfo: MCPServerInfo): Promise<void> {
    logger.info(`Installing dependencies for ${serverInfo.type} MCP server`);

    try {
      if (serverInfo.type === 'npm' && serverInfo.packageJson) {
        // Install npm dependencies
        await execAsync('npm install', { cwd: repoPath });

        // Build if build script exists
        if (serverInfo.packageJson.scripts?.build) {
          await execAsync('npm run build', { cwd: repoPath });
        }
      } else if (serverInfo.type === 'python' && serverInfo.requirements) {
        // Install Python dependencies
        await execAsync('pip install -r requirements.txt', { cwd: repoPath });
      } else if (serverInfo.type === 'docker') {
        // Build Docker image
        const imageName = `mcp-auto-${Date.now()}`;
        await execAsync(`docker build -t ${imageName} .`, { cwd: repoPath });

        // Update command to use the built image
        serverInfo.command = 'docker';
        serverInfo.args = ['run', '-i', '--rm', '--init', imageName];
      }
    } catch (error) {
      logger.error('Failed to install dependencies:', error);
      throw new Error(`Failed to install dependencies: ${error}`);
    }
  }

  /**
   * Auto-install MCP server from GitHub URL
   */
  async installFromGitHub(url: string, name?: string): Promise<string> {
    logger.info(`Auto-installing MCP server from GitHub: ${url}`);

    // Parse GitHub URL
    const repo = this.parseGitHubUrl(url);
    if (!repo) {
      throw new Error(`Invalid GitHub URL: ${url}`);
    }

    let repoPath: string;
    let serverInfo: MCPServerInfo;

    try {
      // Clone repository
      repoPath = await this.cloneRepo(repo);

      // Detect MCP server
      serverInfo = await this.detectMCPServer(repoPath);

      if (!serverInfo.detected) {
        throw new Error('No MCP server detected in repository');
      }

      logger.info(`Detected ${serverInfo.type} MCP server: ${serverInfo.command}`);

      // Install dependencies
      await this.installDependencies(repoPath, serverInfo);

      // Create stdio:// URL for the server
      let stdioUrl: string;
      if (serverInfo.type === 'docker') {
        stdioUrl = `stdio://docker run -i --rm --init ${serverInfo.args?.slice(4).join(' ') || ''}`;
      } else {
        const fullCommand = serverInfo.args
          ? `${serverInfo.command} ${serverInfo.args.join(' ')}`
          : serverInfo.command;
        stdioUrl = `stdio://${fullCommand}`;
      }

      // Update command to include working directory for non-Docker
      if (serverInfo.type !== 'docker') {
        stdioUrl = `stdio://cd ${repoPath} && ${serverInfo.command}`;
      }

      // Connect to the MCP server
      const result = await mcpClientService.connect(stdioUrl, name || `${repo.owner}/${repo.repo}`);

      logger.info(`Successfully auto-installed MCP server from ${url}`);
      return result;
    } catch (error) {
      logger.error(`Failed to auto-install MCP server from ${url}:`, error);

      // Cleanup on failure
      if (repoPath!) {
        try {
          await execAsync(`rm -rf ${repoPath}`);
        } catch (cleanupError) {
          logger.warn('Failed to cleanup failed installation:', cleanupError);
        }
      }

      throw error;
    }
  }

  /**
   * Sanitize and validate package name to prevent corruption from free models
   */
  private sanitizePackageName(input: string): string {
    // Try to extract valid package names from corrupted text
    const packagePatterns = [
      // Look for npm package patterns anywhere in the text
      /@?[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?(?:-mcp)?/gi,
      // Look for common MCP package names
      /[a-z]+(?:-mcp|-server)/gi,
      // Look for scoped packages
      /@[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*/gi,
    ];

    let bestMatch = '';

    // Try each pattern to find the best package name
    for (const pattern of packagePatterns) {
      const matches = input.match(pattern);
      if (matches) {
        // Find the longest match that looks like a real package name
        for (const match of matches) {
          const normalized = match.toLowerCase();
          if (
            normalized.length > bestMatch.length &&
            (normalized.includes('mcp') ||
              normalized.includes('@') ||
              normalized.includes('-server'))
          ) {
            bestMatch = normalized;
          }
        }
      }
    }

    // If no good match found, try basic cleanup
    if (!bestMatch) {
      bestMatch = input
        .trim()
        .replace(/[^a-zA-Z0-9\-_@\/\.]/g, '') // Remove invalid characters
        .toLowerCase();
    }

    // Validate it looks like a real package name
    if (!bestMatch || bestMatch.length < 2 || !bestMatch.match(/^(@[\w\-]+\/)?[\w\-\.]+$/)) {
      throw new Error(
        `Invalid package name after sanitization: "${input}" -> "${bestMatch}". Expected format: "package-name" or "@scope/package-name"`
      );
    }

    return bestMatch;
  }

  /**
   * Install MCP server from npm package with intelligent dependency resolution
   */
  async installFromNpm(packageName: string, name?: string): Promise<string> {
    // Sanitize package name to prevent free model corruption
    const sanitizedPackageName = this.sanitizePackageName(packageName);
    logger.info(
      `Installing MCP server from npm (sanitized: ${packageName} -> ${sanitizedPackageName})`
    );

    try {
      // Step 1: Try direct npx first (fast and simple)
      logger.info(`Attempting direct installation: ${sanitizedPackageName}`);
      const directCommand = `stdio://npx ${sanitizedPackageName}`;

      try {
        // Quick timeout wrapper to fail fast on broken packages
        const result = await Promise.race([
          mcpClientService.connect(directCommand, name || sanitizedPackageName),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Fast timeout')), 5000)),
        ]);
        logger.info(`✅ Direct installation successful: ${sanitizedPackageName}`);
        return `Successfully installed ${sanitizedPackageName} using direct npx strategy`;
      } catch (directError) {
        logger.info(
          `Direct installation failed, trying Docker fallback: ${directError instanceof Error ? directError.message : String(directError)}`
        );

        // Step 2: Try Docker fallback for known problematic packages
        if (sanitizedPackageName.includes('puppeteer')) {
          const dockerCommand = `stdio://docker run -i --rm ghcr.io/puppeteer/puppeteer`;
          try {
            const result = await mcpClientService.connect(
              dockerCommand,
              name || sanitizedPackageName
            );
            logger.info(`✅ Docker fallback successful: ${sanitizedPackageName}`);
            return `Successfully installed ${sanitizedPackageName} using Docker strategy (dependencies bundled)`;
          } catch (dockerError) {
            logger.error(
              `Docker fallback also failed: ${dockerError instanceof Error ? dockerError.message : String(dockerError)}`
            );
            throw new Error(
              `Both direct and Docker installation failed for ${sanitizedPackageName}: ${directError instanceof Error ? directError.message : String(directError)}`
            );
          }
        } else {
          // For non-Puppeteer packages, just fail with the direct error
          throw directError;
        }
      }
    } catch (error) {
      logger.error(`Failed to install MCP server from npm ${sanitizedPackageName}:`, error);

      // Enhanced error handling with fallback suggestions
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          throw new Error(
            `Installation timeout for ${sanitizedPackageName}. This package may need to download dependencies. The auto-installer will handle this automatically next time.`
          );
        }
        if (error.message.includes('dependency')) {
          throw new Error(
            `Dependency issue with ${sanitizedPackageName}: ${error.message}. Try using Docker fallback or manual dependency installation.`
          );
        }
      }

      throw error;
    }
  }

  /**
   * Install MCP server from Docker image
   */
  async installFromDocker(imageName: string, name?: string, args?: string[]): Promise<string> {
    logger.info(`Installing MCP server from Docker: ${imageName}`);

    try {
      // Create stdio:// URL for Docker image
      const dockerArgs = args ? ` ${args.join(' ')}` : '';
      const stdioUrl = `stdio://docker/${imageName}${dockerArgs}`;

      // Connect to the MCP server
      const result = await mcpClientService.connect(stdioUrl, name || imageName);

      logger.info(`Successfully installed MCP server from Docker: ${imageName}`);
      return result;
    } catch (error) {
      logger.error(`Failed to install MCP server from Docker ${imageName}:`, error);
      throw error;
    }
  }

  /**
   * Detect and install MCP server from any URL
   */
  async autoInstall(url: string, name?: string): Promise<string> {
    // Detect URL type and route to appropriate installer
    if (url.includes('github.com')) {
      return this.installFromGitHub(url, name);
    } else if (url.startsWith('npm:') || url.includes('npmjs.com')) {
      const packageName = url.replace(/^npm:/, '').replace(/.*npmjs\.com\/package\//, '');
      return this.installFromNpm(packageName, name);
    } else if (
      url.startsWith('docker:') ||
      url.includes('docker.io') ||
      url.includes('hub.docker.com')
    ) {
      const imageName = url
        .replace(/^docker:/, '')
        .replace(/.*docker\.io\//, '')
        .replace(/.*hub\.docker\.com\//, '');
      return this.installFromDocker(imageName, name);
    } else if (url.startsWith('stdio://')) {
      // Direct stdio URL - just connect
      return mcpClientService.connect(url, name);
    } else {
      // Fallback: treat as npm package name if it looks like one
      try {
        this.sanitizePackageName(url); // Test if it's a valid package name
        logger.info(`Treating "${url}" as npm package name`);
        return this.installFromNpm(url, name);
      } catch (sanitizeError) {
        throw new Error(
          `Unsupported URL type and invalid package name: ${url}. ${sanitizeError instanceof Error ? sanitizeError.message : String(sanitizeError)}`
        );
      }
    }
  }

  /**
   * Cleanup temporary files
   */
  async cleanup(): Promise<void> {
    try {
      await execAsync(`rm -rf ${this.tempDir}`);
      logger.info('Cleaned up temporary MCP installation files');
    } catch (error) {
      logger.warn('Failed to cleanup temp files:', error);
    }
  }
}

// Singleton instance
const mcpAutoInstaller = new MCPAutoInstaller();

// Export service for other modules
export { mcpAutoInstaller };

/**
 * MCP Auto-installer capability - automatically detects, installs and connects to MCP servers
 *
 * Supported actions:
 * - install: Auto-install MCP server from GitHub/npm/Docker
 * - install_github: Install from GitHub repository
 * - install_npm: Install from npm package
 * - install_docker: Install from Docker image
 * - cleanup: Clean up temporary installation files
 */
export const mcpAutoInstallerCapability: RegisteredCapability = {
  name: 'mcp_auto_installer',
  supportedActions: ['install', 'install_github', 'install_npm', 'install_docker', 'cleanup'],
  description: 'Automatically installs and connects to MCP servers from GitHub, npm, or Docker',
  handler: async (params: any, content?: string) => {
    const { action } = params;

    try {
      switch (action) {
        case 'install': {
          const url = params.url || content;
          if (!url) {
            throw new Error('URL is required for auto-installation');
          }

          const name = params.name;
          return await mcpAutoInstaller.autoInstall(url, name);
        }

        case 'install_github': {
          const url = params.url || content;
          if (!url) {
            throw new Error('GitHub URL is required');
          }

          const name = params.name;
          return await mcpAutoInstaller.installFromGitHub(url, name);
        }

        case 'install_npm': {
          const packageName = params.package || params.name || content;
          if (!packageName) {
            throw new Error('npm package name is required');
          }

          const name = params.display_name;
          return await mcpAutoInstaller.installFromNpm(packageName, name);
        }

        case 'install_docker': {
          const imageName = params.image || content;
          if (!imageName) {
            throw new Error('Docker image name is required');
          }

          const name = params.name;
          const args = params.args ? params.args.split(' ') : undefined;
          return await mcpAutoInstaller.installFromDocker(imageName, name, args);
        }

        case 'cleanup': {
          await mcpAutoInstaller.cleanup();
          return 'Cleaned up temporary MCP installation files';
        }

        default:
          throw new Error(
            `Unknown MCP auto-installer action: ${action}\n\n` +
            `Available actions: install, install_github, install_npm, install_docker, cleanup\n\n` +
            `Examples:\n` +
            `• <capability name="mcp_auto_installer" action="install" url="npm:@modelcontextprotocol/server-github" />\n` +
            `• <capability name="mcp_auto_installer" action="install_github" url="https://github.com/anthropics/mcp-server-github" />\n` +
            `• <capability name="mcp_auto_installer" action="install_npm" package="@modelcontextprotocol/server-weather" />\n` +
            `• <capability name="mcp_auto_installer" action="install_docker" image="puppeteer/puppeteer" />`
          );
      }
    } catch (error) {
      logger.error(`MCP auto-installer capability failed for action ${action}:`, error);
      throw error;
    }
  },
};
