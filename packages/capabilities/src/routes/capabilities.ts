import { FastifyPluginAsync } from 'fastify';
import { CapabilityRegistry } from '../services/capability-registry';
import { logger } from '@coachartie/shared/dist/utils/logger';

export function createCapabilitiesRoute(registry: CapabilityRegistry): FastifyPluginAsync {
  return async (fastify) => {
    // GET /capabilities - List all available capabilities
    fastify.get('/capabilities', async (request, reply) => {
      try {
        const capabilities = registry.getAllCapabilities();
        const capabilityList = Array.from(capabilities.entries()).map(([name, capability]) => ({
          name,
          description: capability.description || 'No description available',
          actions: capability.actions ? Object.keys(capability.actions) : [],
          enabled: capability.enabled !== false
        }));

        logger.info(`📋 Listed ${capabilityList.length} capabilities`);

        return {
          capabilities: capabilityList,
          total: capabilityList.length,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        logger.error('❌ Error listing capabilities:', error);
        await reply.status(500).send({
          error: 'Failed to list capabilities',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // GET /capabilities/:name - Get specific capability details
    fastify.get<{ Params: { name: string } }>('/capabilities/:name', async (request, reply) => {
      const { name } = request.params;

      try {
        const capability = registry.getCapability(name);
        
        if (!capability) {
          await reply.status(404).send({
            error: 'Capability not found',
            message: `Capability '${name}' does not exist`
          });
          return;
        }

        logger.info(`🔍 Retrieved capability details for: ${name}`);

        return {
          name,
          description: capability.description || 'No description available',
          actions: capability.actions ? Object.keys(capability.actions) : [],
          enabled: capability.enabled !== false,
          metadata: capability.metadata || {},
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        logger.error(`❌ Error getting capability ${name}:`, error);
        await reply.status(500).send({
          error: 'Failed to get capability',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // GET /capabilities/:name/actions - List actions for a specific capability
    fastify.get<{ Params: { name: string } }>('/capabilities/:name/actions', async (request, reply) => {
      const { name } = request.params;

      try {
        const capability = registry.getCapability(name);
        
        if (!capability) {
          await reply.status(404).send({
            error: 'Capability not found',
            message: `Capability '${name}' does not exist`
          });
          return;
        }

        const actions = capability.actions || {};
        const actionList = Object.entries(actions).map(([actionName, actionHandler]) => ({
          name: actionName,
          description: actionHandler.description || 'No description available',
          parameters: actionHandler.parameters || [],
          example: actionHandler.example || null
        }));

        logger.info(`📋 Listed ${actionList.length} actions for capability: ${name}`);

        return {
          capability: name,
          actions: actionList,
          total: actionList.length,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        logger.error(`❌ Error listing actions for capability ${name}:`, error);
        await reply.status(500).send({
          error: 'Failed to list actions',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // GET /capabilities/stats - Get capability usage statistics
    fastify.get('/capabilities/stats', async (request, reply) => {
      try {
        const capabilities = registry.getAllCapabilities();
        const stats = {
          totalCapabilities: capabilities.size,
          enabledCapabilities: Array.from(capabilities.values()).filter(c => c.enabled !== false).length,
          totalActions: Array.from(capabilities.values()).reduce((total, capability) => {
            return total + (capability.actions ? Object.keys(capability.actions).length : 0);
          }, 0),
          capabilitiesByType: {},
          recentActivity: [] // Could be populated from usage logs if available
        };

        logger.info('📊 Generated capability statistics');

        return {
          stats,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        logger.error('❌ Error generating capability stats:', error);
        await reply.status(500).send({
          error: 'Failed to generate stats',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  };
}