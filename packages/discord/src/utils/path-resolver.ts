import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { logger } from '@coachartie/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Bulletproof path resolver for Discord service
 * Handles both Docker (/app/data) and local development (./data) environments
 */
export class PathResolver {
  private static instance: PathResolver;
  private readonly isDocker: boolean;
  private readonly dataDir: string;

  private constructor() {
    // Detect if we're running in Docker
    this.isDocker = this.detectDockerEnvironment();

    // Set appropriate data directory
    if (this.isDocker) {
      this.dataDir = '/app/data';
    } else {
      // Local development: use packages/capabilities/data (shared data directory)
      this.dataDir = resolve(__dirname, '../../../../capabilities/data');
    }

    // Ensure data directory exists
    this.ensureDataDirectory();

    logger.info(
      `📁 Path resolver initialized: ${this.isDocker ? 'Docker' : 'Local'} mode, data dir: ${this.dataDir}`
    );
  }

  public static getInstance(): PathResolver {
    if (!PathResolver.instance) {
      PathResolver.instance = new PathResolver();
    }
    return PathResolver.instance;
  }

  /**
   * Detect if running in Docker container
   */
  private detectDockerEnvironment(): boolean {
    // Check multiple indicators of Docker environment
    const indicators = [
      // Docker creates /.dockerenv file
      existsSync('/.dockerenv'),
      // Docker often sets container-specific env vars
      !!process.env.DOCKER_CONTAINER,
      // Current working directory is /app (common Docker pattern)
      process.cwd() === '/app',
      // Check if we're in a path that looks like Docker
      __dirname.startsWith('/app/'),
    ];

    const isDocker = indicators.some((indicator) => indicator);
    logger.debug(`🔍 Docker detection: ${isDocker ? 'Docker' : 'Local'}`, {
      dockerenv: existsSync('/.dockerenv'),
      dockerContainer: !!process.env.DOCKER_CONTAINER,
      cwd: process.cwd(),
      dirname: __dirname,
    });

    return isDocker;
  }

  /**
   * Ensure data directory exists with proper permissions
   */
  private ensureDataDirectory(): void {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
        logger.info(`📁 Created data directory: ${this.dataDir}`);
      }
    } catch (error) {
      logger.error(`Failed to create data directory: ${this.dataDir}`, error);
      throw new Error(`Cannot create data directory: ${this.dataDir}`);
    }
  }

  /**
   * Get path for Discord status file
   */
  public getStatusFilePath(): string {
    return process.env.DISCORD_STATUS_FILE || join(this.dataDir, 'discord-status.json');
  }

  /**
   * Get path for Discord metrics file
   */
  public getMetricsFilePath(): string {
    return process.env.DISCORD_METRICS_FILE || join(this.dataDir, 'discord-metrics.json');
  }

  /**
   * Get path for Discord events file
   */
  public getEventsFilePath(): string {
    return process.env.DISCORD_EVENTS_FILE || join(this.dataDir, 'discord-events.json');
  }

  /**
   * Get data directory path
   */
  public getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Check if running in Docker
   */
  public isDockerEnvironment(): boolean {
    return this.isDocker;
  }

  /**
   * Resolve any file path within the data directory
   */
  public resolveDataPath(filename: string): string {
    return join(this.dataDir, filename);
  }

  /**
   * Ensure a specific directory exists within data directory
   */
  public ensureDirectory(subPath: string): string {
    const fullPath = this.resolveDataPath(subPath);
    try {
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
        logger.debug(`📁 Created subdirectory: ${fullPath}`);
      }
      return fullPath;
    } catch (error) {
      logger.error(`Failed to create directory: ${fullPath}`, error);
      throw new Error(`Cannot create directory: ${fullPath}`);
    }
  }
}

// Export singleton instance
export const pathResolver = PathResolver.getInstance();
