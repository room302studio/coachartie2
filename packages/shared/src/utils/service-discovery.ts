import { logger } from './logger.js';
import { redis } from './redis.js';

/**
 * Service Discovery System
 * Allows services to register their actual ports and find each other
 */

export interface ServiceInfo {
  name: string;
  port: number;
  host: string;
  url: string;
  status: 'starting' | 'running' | 'stopping';
  lastPing: number;
  pid?: number;
}

export class ServiceDiscovery {
  private static readonly REDIS_PREFIX = 'coachartie:services:';
  private static readonly PING_INTERVAL = 30000; // 30 seconds
  private static instance: ServiceDiscovery;
  
  private registeredServices = new Map<string, ServiceInfo>();
  private pingInterval?: NodeJS.Timeout;

  static getInstance(): ServiceDiscovery {
    if (!ServiceDiscovery.instance) {
      ServiceDiscovery.instance = new ServiceDiscovery();
    }
    return ServiceDiscovery.instance;
  }

  /**
   * Register a service with the discovery system
   */
  async registerService(
    serviceName: string, 
    port: number, 
    host: string = 'localhost'
  ): Promise<void> {
    const serviceInfo: ServiceInfo = {
      name: serviceName,
      port,
      host,
      url: `http://${host}:${port}`,
      status: 'starting',
      lastPing: Date.now(),
      pid: process.pid
    };

    // Store in local map
    this.registeredServices.set(serviceName, serviceInfo);

    // Store in Redis for inter-service discovery
    try {
      await redis.setex(
        `${ServiceDiscovery.REDIS_PREFIX}${serviceName}`,
        90, // TTL of 90 seconds (must be refreshed by pings)
        JSON.stringify(serviceInfo)
      );
      
      logger.info(`📡 Registered ${serviceName} service at ${serviceInfo.url}`);
    } catch (error) {
      logger.warn(`Failed to register service ${serviceName} in Redis:`, error);
      // Continue without Redis - services can still work locally
    }

    // Start ping system if not already running
    this.startPingSystem();
  }

  /**
   * Mark service as fully running (after successful startup)
   */
  async markServiceRunning(serviceName: string): Promise<void> {
    const service = this.registeredServices.get(serviceName);
    if (service) {
      service.status = 'running';
      service.lastPing = Date.now();
      
      try {
        await redis.setex(
          `${ServiceDiscovery.REDIS_PREFIX}${serviceName}`,
          90,
          JSON.stringify(service)
        );
        logger.info(`✅ ${serviceName} service is now running at ${service.url}`);
      } catch (error) {
        logger.warn(`Failed to update service status for ${serviceName}:`, error);
      }
    }
  }

  /**
   * Find a service by name
   */
  async findService(serviceName: string): Promise<ServiceInfo | null> {
    // Try local registry first
    const localService = this.registeredServices.get(serviceName);
    if (localService && localService.status === 'running') {
      return localService;
    }

    // Try Redis for remote services
    try {
      const redisKey = `${ServiceDiscovery.REDIS_PREFIX}${serviceName}`;
      const serviceData = await redis.get(redisKey);
      
      if (serviceData) {
        const service: ServiceInfo = JSON.parse(serviceData);
        // Only return if service is actively running and recently pinged
        if (service.status === 'running' && (Date.now() - service.lastPing) < 60000) {
          return service;
        }
      }
    } catch (error) {
      logger.warn(`Failed to find service ${serviceName} in Redis:`, error);
    }

    return null;
  }

  /**
   * Get all available services
   */
  async getAllServices(): Promise<ServiceInfo[]> {
    const services = new Map<string, ServiceInfo>();

    // Add local services
    for (const [name, service] of this.registeredServices) {
      if (service.status === 'running') {
        services.set(name, service);
      }
    }

    // Add Redis services
    try {
      const keys = await redis.keys(`${ServiceDiscovery.REDIS_PREFIX}*`);
      for (const key of keys) {
        const serviceData = await redis.get(key);
        if (serviceData) {
          const service: ServiceInfo = JSON.parse(serviceData);
          const serviceName = key.replace(ServiceDiscovery.REDIS_PREFIX, '');
          
          // Only include running services with recent pings
          if (service.status === 'running' && (Date.now() - service.lastPing) < 60000) {
            services.set(serviceName, service);
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to get services from Redis:', error);
    }

    return Array.from(services.values());
  }

  /**
   * Get URL for a specific service
   */
  async getServiceUrl(serviceName: string): Promise<string | null> {
    const service = await this.findService(serviceName);
    return service ? service.url : null;
  }

  /**
   * Unregister a service (call on shutdown)
   */
  async unregisterService(serviceName: string): Promise<void> {
    const service = this.registeredServices.get(serviceName);
    if (service) {
      service.status = 'stopping';
      this.registeredServices.delete(serviceName);

      try {
        await redis.del(`${ServiceDiscovery.REDIS_PREFIX}${serviceName}`);
        logger.info(`📡 Unregistered ${serviceName} service`);
      } catch (error) {
        logger.warn(`Failed to unregister service ${serviceName}:`, error);
      }
    }
  }

  /**
   * Start the ping system to keep services alive in Redis
   */
  private startPingSystem(): void {
    if (this.pingInterval) return; // Already running

    this.pingInterval = setInterval(async () => {
      for (const [serviceName, service] of this.registeredServices) {
        if (service.status === 'running') {
          service.lastPing = Date.now();
          
          try {
            await redis.setex(
              `${ServiceDiscovery.REDIS_PREFIX}${serviceName}`,
              90,
              JSON.stringify(service)
            );
          } catch (error) {
            logger.warn(`Failed to ping service ${serviceName}:`, error);
          }
        }
      }
    }, ServiceDiscovery.PING_INTERVAL);
  }

  /**
   * Stop the ping system (call on shutdown)
   */
  stopPingSystem(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  /**
   * Handle graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.stopPingSystem();
    
    // Unregister all local services
    const serviceNames = Array.from(this.registeredServices.keys());
    await Promise.all(serviceNames.map(name => this.unregisterService(name)));
    
    logger.info('📡 Service discovery shutdown complete');
  }
}

// Export singleton instance
export const serviceDiscovery = ServiceDiscovery.getInstance();

/**
 * Convenience function to register service and handle startup
 */
export async function registerServiceWithDiscovery(
  serviceName: string,
  port: number,
  onReady?: () => void
): Promise<void> {
  await serviceDiscovery.registerService(serviceName, port);
  
  // Mark as running after brief delay for startup
  setTimeout(async () => {
    await serviceDiscovery.markServiceRunning(serviceName);
    if (onReady) onReady();
  }, 1000);
}

/**
 * Helper to get service URLs with fallbacks
 */
export async function getServiceUrlWithFallback(
  serviceName: string,
  fallbackPort: number,
  fallbackHost: string = 'localhost'
): Promise<string> {
  const serviceUrl = await serviceDiscovery.getServiceUrl(serviceName);
  
  if (serviceUrl) {
    return serviceUrl;
  }
  
  // Return fallback URL
  const fallbackUrl = `http://${fallbackHost}:${fallbackPort}`;
  logger.warn(`Service ${serviceName} not found in discovery, using fallback: ${fallbackUrl}`);
  return fallbackUrl;
}