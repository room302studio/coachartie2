import { createServer } from 'net';

/**
 * Port selection for the engine's HTTP server: parsePortWithFallback is the only export.
 * Wave 6 trimmed the unused helpers (getMultiplePorts, reservePort) and un-exported the
 * internals; the env-var-then-auto-discovery behavior is unchanged.
 */

interface PortDiscoveryOptions {
  startPort: number;
  endPort?: number;
  maxAttempts?: number;
}

/**
 * Check if a specific port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
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
async function findAvailablePort(options: PortDiscoveryOptions): Promise<number> {
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

/** Default ports per service name. */
const DEFAULT_PORTS = {
  redis: 47320,
  discord: 47321,
  irc: 47322,
  capabilities: 47324,
  brain: 47325,
  sms: 47326,
  email: 35892, // Not currently used but keeping for future
};

/**
 * Get an available port for a specific service
 */
async function getServicePort(
  serviceName: keyof typeof DEFAULT_PORTS,
  customStartPort?: number
): Promise<number> {
  const startPort = customStartPort || DEFAULT_PORTS[serviceName];

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
 * Environment variable port parsing with fallback to auto-discovery
 */
export function parsePortWithFallback(
  envVarName: string,
  serviceName: keyof typeof DEFAULT_PORTS,
  defaultPort?: number
): Promise<number> {
  const envPort = process.env[envVarName];

  if (envPort && !isNaN(parseInt(envPort))) {
    const port = parseInt(envPort);
    console.log(`Using port ${port} from environment variable ${envVarName}`);
    return Promise.resolve(port);
  }

  return getServicePort(serviceName, defaultPort);
}
