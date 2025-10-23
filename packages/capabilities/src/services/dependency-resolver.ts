import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, readFile } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

/**
 * Dependency requirement definition
 */
export interface DependencyRequirement {
  name: string;
  type: 'binary' | 'package' | 'service' | 'docker_image';
  checkCommand?: string;
  installCommand?: string;
  dockerFallback?: string;
  platforms?: string[];
  required: boolean;
}

/**
 * MCP dependency profile
 */
export interface MCPDependencyProfile {
  packageName: string;
  dependencies: DependencyRequirement[];
  fallbackStrategies: FallbackStrategy[];
}

/**
 * Fallback strategy when dependencies fail
 */
export interface FallbackStrategy {
  type: 'docker' | 'alternative_package' | 'system_install';
  command?: string;
  dockerImage?: string;
  alternativePackage?: string;
  priority: number;
}

/**
 * Dependency resolution result
 */
export interface DependencyResolution {
  success: boolean;
  strategy: 'direct' | 'docker' | 'system_install';
  command: string;
  missingDependencies: string[];
  installedDependencies: string[];
  error?: string;
}

/**
 * Universal Dependency Resolver for MCP servers
 */
export class DependencyResolver {
  private profiles = new Map<string, MCPDependencyProfile>();

  constructor() {
    this.initializeKnownProfiles();
  }

  /**
   * Initialize known dependency profiles for common MCP servers
   */
  private initializeKnownProfiles(): void {
    // Puppeteer MCP profile
    this.profiles.set('@modelcontextprotocol/server-puppeteer', {
      packageName: '@modelcontextprotocol/server-puppeteer',
      dependencies: [
        {
          name: 'chrome',
          type: 'binary',
          checkCommand: 'which google-chrome || which chromium || which chrome',
          installCommand: this.getChromeInstallCommand(),
          dockerFallback: 'ghcr.io/puppeteer/puppeteer',
          required: true,
        },
      ],
      fallbackStrategies: [
        {
          type: 'docker',
          dockerImage: 'ghcr.io/puppeteer/puppeteer',
          priority: 1,
        },
        {
          type: 'system_install',
          priority: 2,
        },
      ],
    });

    // Filesystem MCP (needs specific paths)
    this.profiles.set('@modelcontextprotocol/server-filesystem', {
      packageName: '@modelcontextprotocol/server-filesystem',
      dependencies: [
        {
          name: 'filesystem_access',
          type: 'service',
          checkCommand: 'echo "always available"',
          required: true,
        },
      ],
      fallbackStrategies: [
        {
          type: 'docker',
          dockerImage: 'mcp/filesystem',
          priority: 1,
        },
      ],
    });

    // GitHub MCP (needs git)
    this.profiles.set('@modelcontextprotocol/server-github', {
      packageName: '@modelcontextprotocol/server-github',
      dependencies: [
        {
          name: 'git',
          type: 'binary',
          checkCommand: 'which git',
          installCommand: 'brew install git || apt-get install git || yum install git',
          required: true,
        },
      ],
      fallbackStrategies: [
        {
          type: 'docker',
          dockerImage: 'mcp/github',
          priority: 1,
        },
        {
          type: 'system_install',
          priority: 2,
        },
      ],
    });
  }

  /**
   * Get platform-specific Chrome install command
   */
  private getChromeInstallCommand(): string {
    const platform = process.platform;
    switch (platform) {
      case 'darwin':
        return 'brew install --cask google-chrome';
      case 'linux':
        return 'wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - && apt-get update && apt-get install google-chrome-stable';
      case 'win32':
        return 'winget install Google.Chrome';
      default:
        return 'echo "Unsupported platform for automatic Chrome install"';
    }
  }

  /**
   * Check if a dependency is available
   */
  private async checkDependency(dep: DependencyRequirement): Promise<boolean> {
    if (!dep.checkCommand) {
      return true;
    }

    try {
      // Add timeout to prevent hanging on slow filesystem/PATH issues
      await execAsync(dep.checkCommand, { timeout: 5000 });
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Install a dependency
   */
  private async installDependency(dep: DependencyRequirement): Promise<boolean> {
    if (!dep.installCommand) {
      return false;
    }

    try {
      logger.info(`Installing dependency: ${dep.name}`);
      // Add timeout for install commands too
      await execAsync(dep.installCommand, { timeout: 30000 });

      // Verify installation
      return await this.checkDependency(dep);
    } catch (error) {
      logger.error(`Failed to install dependency ${dep.name}:`, error);
      return false;
    }
  }

  /**
   * Resolve dependencies for an MCP package
   */
  async resolveDependencies(packageName: string): Promise<DependencyResolution> {
    const profile = this.profiles.get(packageName);

    if (!profile) {
      // No known dependencies, try direct installation
      return {
        success: true,
        strategy: 'direct',
        command: `stdio://npx ${packageName}`,
        missingDependencies: [],
        installedDependencies: [],
      };
    }

    const missingDependencies: string[] = [];
    const installedDependencies: string[] = [];

    // Check all dependencies
    for (const dep of profile.dependencies) {
      const isAvailable = await this.checkDependency(dep);

      if (!isAvailable) {
        if (dep.required) {
          missingDependencies.push(dep.name);
        }
      } else {
        installedDependencies.push(dep.name);
      }
    }

    // If no missing dependencies, use direct installation
    if (missingDependencies.length === 0) {
      return {
        success: true,
        strategy: 'direct',
        command: `stdio://npx ${packageName}`,
        missingDependencies: [],
        installedDependencies,
      };
    }

    // Try fallback strategies
    for (const strategy of profile.fallbackStrategies.sort((a, b) => a.priority - b.priority)) {
      if (strategy.type === 'docker' && strategy.dockerImage) {
        return {
          success: true,
          strategy: 'docker',
          command: `stdio://docker/${strategy.dockerImage}`,
          missingDependencies,
          installedDependencies,
        };
      }

      if (strategy.type === 'system_install') {
        // Try to install missing dependencies
        let installSuccess = true;
        const newlyInstalled: string[] = [];

        for (const depName of missingDependencies) {
          const dep = profile.dependencies.find((d) => d.name === depName);
          if (dep) {
            const installed = await this.installDependency(dep);
            if (installed) {
              newlyInstalled.push(dep.name);
            } else {
              installSuccess = false;
              break;
            }
          }
        }

        if (installSuccess) {
          return {
            success: true,
            strategy: 'system_install',
            command: `stdio://npx ${packageName}`,
            missingDependencies: [],
            installedDependencies: [...installedDependencies, ...newlyInstalled],
          };
        }
      }
    }

    // All strategies failed
    return {
      success: false,
      strategy: 'direct',
      command: '',
      missingDependencies,
      installedDependencies,
      error: `Unable to resolve dependencies: ${missingDependencies.join(', ')}`,
    };
  }

  /**
   * Add a custom dependency profile
   */
  addProfile(profile: MCPDependencyProfile): void {
    this.profiles.set(profile.packageName, profile);
    logger.info(`Added dependency profile for ${profile.packageName}`);
  }

  /**
   * Get all registered profiles
   */
  getProfiles(): string[] {
    return Array.from(this.profiles.keys());
  }

  /**
   * Auto-detect dependencies from package.json or source
   */
  async detectDependencies(packagePath: string): Promise<DependencyRequirement[]> {
    const dependencies: DependencyRequirement[] = [];

    try {
      // Check package.json for hints
      const packageJsonPath = join(packagePath, 'package.json');
      const packageContent = await readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageContent);

      // Look for common dependency patterns
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies,
      };

      // Detect Puppeteer
      if (allDeps.puppeteer || allDeps['puppeteer-core']) {
        dependencies.push({
          name: 'chrome',
          type: 'binary',
          checkCommand: 'which google-chrome || which chromium',
          installCommand: this.getChromeInstallCommand(),
          required: true,
        });
      }

      // Detect Git dependencies
      if (allDeps['simple-git'] || allDeps.git || packageJson.name?.includes('git')) {
        dependencies.push({
          name: 'git',
          type: 'binary',
          checkCommand: 'which git',
          installCommand: 'brew install git || apt-get install git',
          required: true,
        });
      }

      // Detect Docker
      if (allDeps.dockerode || packageJson.name?.includes('docker')) {
        dependencies.push({
          name: 'docker',
          type: 'binary',
          checkCommand: 'which docker',
          installCommand: 'echo "Please install Docker manually"',
          required: true,
        });
      }
    } catch (_error) {}

    return dependencies;
  }
}

// Singleton instance
export const dependencyResolver = new DependencyResolver();
