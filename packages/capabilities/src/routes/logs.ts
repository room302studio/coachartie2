import { Router } from 'express';
import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const router: Router = Router();

// In-memory log storage for this session
const jobLogs = new Map<string, Array<{timestamp: string, level: string, message: string}>>();

/**
 * Store a log entry for a specific job
 */
export function logForJob(jobId: string, level: string, message: string) {
  if (!jobLogs.has(jobId)) {
    jobLogs.set(jobId, []);
  }
  
  jobLogs.get(jobId)!.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });
}

/**
 * GET /logs/:jobId - Get logs for a specific job
 */
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { format = 'json', lines = 100 } = req.query;

    logger.info(`🔍 Retrieving logs for job ${jobId}`);

    // First check in-memory logs
    const memoryLogs = jobLogs.get(jobId) || [];
    
    // Also search Docker logs for this job ID
    let dockerLogs: any[] = [];
    try {
      const { stdout } = await execAsync(
        `docker logs coachartie2-capabilities-1 --since="1h" 2>&1 | grep -i "${jobId}" | tail -${lines}`,
        { maxBuffer: 1024 * 1024 } // 1MB buffer
      );
      
      if (stdout) {
        dockerLogs = stdout.trim().split('\n')
          .filter(line => line.includes(jobId))
          .map(line => {
            // Parse Docker log format: timestamp level message
            const match = line.match(/^(\d{2}:\d{2}:\d{2})\s+(\w+):\s*(.+)$/);
            if (match) {
              return {
                timestamp: match[1],
                level: match[2],
                message: match[3]
              };
            }
            return {
              timestamp: new Date().toISOString(),
              level: 'info',
              message: line
            };
          });
      }
    } catch (dockerError) {
      logger.warn(`Could not retrieve Docker logs: ${dockerError}`);
    }

    // Combine and sort logs
    const allLogs = [...memoryLogs, ...dockerLogs].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    if (format === 'text') {
      const textLogs = allLogs.map(log => 
        `${log.timestamp} [${log.level.toUpperCase()}] ${log.message}`
      ).join('\n');
      
      res.setHeader('Content-Type', 'text/plain');
      res.send(textLogs);
    } else {
      res.json({
        jobId,
        logCount: allLogs.length,
        logs: allLogs,
        retrieved: new Date().toISOString()
      });
    }

  } catch (error) {
    logger.error('Error retrieving logs:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve logs', 
      details: error instanceof Error ? error.message : String(error) 
    });
  }
});

/**
 * GET /logs - Get logs for multiple jobs or general service logs
 */
router.get('/', async (req, res) => {
  try {
    const { jobs, since = '1h', lines = 100, format = 'json', level } = req.query;
    
    let grepPattern = '';
    if (jobs) {
      // Multiple job IDs separated by commas
      const jobIds = (jobs as string).split(',').map(id => id.trim());
      grepPattern = jobIds.map(id => `-e "${id}"`).join(' ');
      logger.info(`🔍 Retrieving logs for jobs: ${jobIds.join(', ')}`);
    } else {
      // General service logs
      logger.info(`🔍 Retrieving general service logs (${since}, ${lines} lines)`);
    }

    // Build Docker logs command
    let cmd = `docker logs coachartie2-capabilities-1 --since="${since}" 2>&1`;
    
    if (grepPattern) {
      cmd += ` | grep ${grepPattern}`;
    }
    
    if (level) {
      cmd += ` | grep -i "${level}:"`;
    }
    
    cmd += ` | tail -${lines}`;

    const { stdout } = await execAsync(cmd, { maxBuffer: 2 * 1024 * 1024 }); // 2MB buffer

    if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain');
      res.send(stdout || 'No logs found');
    } else {
      const logs = stdout ? stdout.trim().split('\n').map(line => {
        // Parse log format
        const match = line.match(/^(\d{2}:\d{2}:\d{2})\s+(\w+):\s*(.+)$/);
        if (match) {
          return {
            timestamp: match[1],
            level: match[2],
            message: match[3]
          };
        }
        return {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: line
        };
      }) : [];

      res.json({
        query: { jobs, since, lines, level },
        logCount: logs.length,
        logs,
        retrieved: new Date().toISOString()
      });
    }

  } catch (error) {
    logger.error('Error retrieving service logs:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve service logs', 
      details: error instanceof Error ? error.message : String(error) 
    });
  }
});

/**
 * GET /logs/search/:query - Search logs by content
 */
router.get('/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const { since = '1h', lines = 50, format = 'json' } = req.query;

    logger.info(`🔍 Searching logs for: "${query}"`);

    const cmd = `docker logs coachartie2-capabilities-1 --since="${since}" 2>&1 | grep -i "${query}" | tail -${lines}`;
    const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 });

    if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain');
      res.send(stdout || 'No matching logs found');
    } else {
      const logs = stdout ? stdout.trim().split('\n').map(line => ({
        timestamp: new Date().toISOString(),
        message: line,
        matchedQuery: query
      })) : [];

      res.json({
        searchQuery: query,
        logCount: logs.length,
        logs,
        retrieved: new Date().toISOString()
      });
    }

  } catch (error) {
    logger.error('Error searching logs:', error);
    res.status(500).json({ 
      error: 'Failed to search logs', 
      details: error instanceof Error ? error.message : String(error) 
    });
  }
});

export { router as logsRouter };