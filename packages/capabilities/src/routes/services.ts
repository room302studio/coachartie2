import { Router } from 'express';
import { logger } from '@coachartie/shared';
import { serviceDiscovery } from '@coachartie/shared';

export const servicesRouter = Router();

/**
 * Get all available services
 */
servicesRouter.get('/', async (req, res) => {
  try {
    const services = await serviceDiscovery.getAllServices();
    res.json({
      success: true,
      services,
      count: services.length
    });
  } catch (error) {
    logger.error('Failed to get services:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get services',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get a specific service
 */
servicesRouter.get('/:serviceName', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const service = await serviceDiscovery.findService(serviceName);
    
    if (!service) {
      return res.status(404).json({
        success: false,
        error: `Service '${serviceName}' not found`
      });
    }
    
    res.json({
      success: true,
      service
    });
  } catch (error) {
    logger.error('Failed to get service:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get service',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get URL for a specific service
 */
servicesRouter.get('/:serviceName/url', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const url = await serviceDiscovery.getServiceUrl(serviceName);
    
    if (!url) {
      return res.status(404).json({
        success: false,
        error: `Service '${serviceName}' not found`
      });
    }
    
    res.json({
      success: true,
      url
    });
  } catch (error) {
    logger.error('Failed to get service URL:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get service URL',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});