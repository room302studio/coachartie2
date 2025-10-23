import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { schedulerService, ScheduledTask } from '../services/scheduler.js';

const router: Router = Router();

// GET /scheduler/tasks - List all scheduled tasks
router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const tasks = await schedulerService.getScheduledTasks();

    res.json({
      success: true,
      count: tasks.length,
      tasks,
    });
  } catch (error) {
    logger.error('Error listing scheduled tasks:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// POST /scheduler/tasks - Create a new scheduled task
router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const { id, name, cron, data, options } = req.body;

    if (!id || !name || !cron) {
      return res.status(400).json({
        success: false,
        error: 'id, name, and cron are required',
      });
    }

    const task: ScheduledTask = {
      id,
      name,
      cron,
      data: data || {},
      options: options || {},
    };

    await schedulerService.scheduleTask(task);

    res.json({
      success: true,
      message: `Scheduled task '${name}' created successfully`,
      task,
    });
  } catch (error) {
    logger.error('Error creating scheduled task:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// DELETE /scheduler/tasks/:taskId - Remove a scheduled task
router.delete('/tasks/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    await schedulerService.removeTask(taskId);

    res.json({
      success: true,
      message: `Scheduled task '${taskId}' removed successfully`,
    });
  } catch (error) {
    logger.error(`Error removing scheduled task '${req.params.taskId}':`, error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// POST /scheduler/once - Schedule a one-time job
router.post('/once', async (req: Request, res: Response) => {
  try {
    const { name, data, delay } = req.body;

    if (!name || delay === undefined) {
      return res.status(400).json({
        success: false,
        error: 'name and delay are required',
      });
    }

    await schedulerService.scheduleOnce(name, data || {}, delay);

    res.json({
      success: true,
      message: `One-time job '${name}' scheduled successfully`,
      delay,
    });
  } catch (error) {
    logger.error('Error scheduling one-time job:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// GET /scheduler/stats - Get scheduler statistics
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await schedulerService.getStats();

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error('Error getting scheduler stats:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// POST /scheduler/setup - Setup default tasks
router.post('/setup', async (req: Request, res: Response) => {
  try {
    await schedulerService.setupDefaultTasks();

    res.json({
      success: true,
      message: 'Default scheduled tasks setup completed',
    });
  } catch (error) {
    logger.error('Error setting up default tasks:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// POST /scheduler/test - Test scheduler with immediate job
router.post('/test', async (req: Request, res: Response) => {
  try {
    const { type = 'health-check' } = req.body;

    await schedulerService.scheduleOnce(
      `test-${type}`,
      {
        type,
        testRun: true,
        timestamp: new Date().toISOString(),
      },
      1000 // 1 second delay
    );

    res.json({
      success: true,
      message: `Test job '${type}' scheduled to run in 1 second`,
    });
  } catch (error) {
    logger.error('Error scheduling test job:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// GET /scheduler/health - Scheduler health check
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'scheduler',
    timestamp: new Date().toISOString(),
    features: {
      cronJobs: true,
      onceJobs: true,
      repeatableJobs: true,
      queueManagement: true,
    },
  });
});

export { router as schedulerRouter };
