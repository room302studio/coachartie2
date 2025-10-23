import { createServer } from 'net';

/**
 * Port Discovery Utility
 * Automatically finds available ports to eliminate manual process killing
 */

export interface PortDiscoveryOptions {
  startPort: number;
  endPort?: number;
  maxAttempts?: number;
}

/**
 * Check if a specific port is available
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.listen(port, '0.0.0.0', () => {
      server.close(() => resolve(true));
    });

    server.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Find the next available port starting from a base port
 */
export async function findAvailablePort(options: PortDiscoveryOptions): Promise<number> {
  const { startPort, endPort = startPort + 100, maxAttempts = 50 } = options;

  for (let port = startPort; port <= Math.min(endPort, startPort + maxAttempts - 1); port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(
    `No available ports found in range ${startPort}-${Math.min(endPort, startPort + maxAttempts - 1)}`
  );
}

/**
 * Service-specific port discovery with sensible defaults
 */
export class PortDiscovery {
  private static readonly DEFAULT_PORTS = {
    redis: 47320,
    discord: 47321,
    capabilities: 47324,
    brain: 47325,
    sms: 47326,
    email: 35892, // Not currently used but keeping for future
  };

  /**
   * Get an available port for a specific service
   */
  static async getServicePort(
    serviceName: keyof (typeof PortDiscovery)['DEFAULT_PORTS'],
    customStartPort?: number
  ): Promise<number> {
    const startPort = customStartPort || PortDiscovery.DEFAULT_PORTS[serviceName];

    try {
      const availablePort = await findAvailablePort({
        startPort,
        maxAttempts: 50,
      });

      if (availablePort !== startPort) {
        console.log(
          `⚠️  Default port ${startPort} for ${serviceName} service was busy, using port ${availablePort}`
        );
      } else {
        console.log(`✅ ${serviceName} service using default port ${availablePort}`);
      }

      return availablePort;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to find available port for ${serviceName} service: ${errorMessage}`);
    }
  }

  /**
   * Get multiple ports for services that need them
   */
  static async getMultiplePorts(count: number, startPort: number): Promise<number[]> {
    const ports: number[] = [];
    let currentPort = startPort;

    for (let i = 0; i < count; i++) {
      const availablePort = await findAvailablePort({
        startPort: currentPort,
        maxAttempts: 20,
      });
      ports.push(availablePort);
      currentPort = availablePort + 1; // Start next search from next port
    }

    return ports;
  }

  /**
   * Reserve a port temporarily (useful for testing)
   */
  static async reservePort(port: number, durationMs: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer();

      server.listen(port, '0.0.0.0', () => {
        setTimeout(() => {
          server.close(() => resolve());
        }, durationMs);
      });

      server.on('error', reject);
    });
  }
}

/**
 * Environment variable port parsing with fallback to auto-discovery
 */
export function parsePortWithFallback(
  envVarName: string,
  serviceName: keyof (typeof PortDiscovery)['DEFAULT_PORTS'],
  defaultPort?: number
): Promise<number> {
  const envPort = process.env[envVarName];

  if (envPort && !isNaN(parseInt(envPort))) {
    const port = parseInt(envPort);
    console.log(`Using port ${port} from environment variable ${envVarName}`);
    return Promise.resolve(port);
  }

  return PortDiscovery.getServicePort(serviceName, defaultPort);
}
