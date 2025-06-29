import { logger } from '@coachartie/shared';
import { schedulerService } from '../services/scheduler.js';
import { publishMessage } from '../queues/publisher.js';

interface TaskData {
  type: string;
  repositories?: string[];
  interval?: number;
  [key: string]: unknown;
}

interface DeploymentMonitorConfig {
  repositories: string[]; // List of repos to monitor
  checkInterval: string; // Cron expression
  celebrationChannel?: string; // Discord channel for celebrations
  weeklyReportDay?: string; // Day for weekly summary (e.g., "monday")
  weeklyReportTime?: string; // Time for weekly summary (e.g., "09:00")
}

export class DeploymentMonitor {
  private config: DeploymentMonitorConfig;
  private isInitialized = false;

  constructor(config: DeploymentMonitorConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info('🔄 Deployment monitor already initialized');
      return;
    }

    logger.info('🚀 Initializing deployment monitor...', {
      repositories: this.config.repositories.length,
      checkInterval: this.config.checkInterval
    });

    try {
      // Schedule regular deployment checks
      await schedulerService.scheduleTask({
        id: 'deployment-monitor-check',
        name: 'Deployment Monitor - Regular Check',
        cron: this.config.checkInterval,
        data: {
          type: 'deployment-check',
          repositories: this.config.repositories,
          action: 'monitor_releases'
        }
      });

      // Schedule weekly summary if configured
      if (this.config.weeklyReportDay && this.config.weeklyReportTime) {
        const [hour, minute] = this.config.weeklyReportTime.split(':');
        const weeklyHour = parseInt(hour);
        const weeklyMinute = parseInt(minute);
        
        // Generate cron for weekly report (e.g., "0 9 * * 1" for Monday 9 AM)
        const dayOfWeek = this.getDayOfWeekNumber(this.config.weeklyReportDay);
        const weeklyCron = `${weeklyMinute} ${weeklyHour} * * ${dayOfWeek}`;

        await schedulerService.scheduleTask({
          id: 'deployment-weekly-summary',
          name: 'Deployment Monitor - Weekly Summary',
          cron: weeklyCron,
          data: {
            type: 'deployment-weekly-summary',
            repositories: this.config.repositories,
            action: 'generate_weekly_summary'
          }
        });

        logger.info(`📅 Weekly deployment summary scheduled for ${this.config.weeklyReportDay} at ${this.config.weeklyReportTime}`);
      }

      this.isInitialized = true;
      logger.info('✅ Deployment monitor initialized successfully');

    } catch (error) {
      logger.error('❌ Failed to initialize deployment monitor:', error);
      throw error;
    }
  }

  async processScheduledTask(taskData: TaskData): Promise<void> {
    const { type, repositories } = taskData;

    logger.info(`🔄 Processing scheduled deployment task: ${type}`, { repositories: repositories?.length || 0 });

    switch (type) {
      case 'deployment-check':
        await this.checkRepositoriesForDeployments(repositories || []);
        break;
      
      case 'deployment-weekly-summary':
        await this.generateWeeklySummary(repositories || []);
        break;
      
      default:
        logger.warn(`❓ Unknown deployment task type: ${type}`);
    }
  }

  private async checkRepositoriesForDeployments(repositories: string[]): Promise<void> {
    logger.info(`🔍 Checking ${repositories.length} repositories for recent deployments`);

    for (const repo of repositories) {
      try {
        // Use deployment cheerleader to monitor releases (last 4 hours)
        await publishMessage(
          'deployment-monitor',
          `<capability name="deployment_cheerleader" action="monitor_releases" repo="${repo}" hours="4" />`,
          'general',
          'Deployment Monitor',
          true
        );

        // Small delay to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        logger.error(`❌ Failed to check repository ${repo}:`, error);
      }
    }
  }

  private async generateWeeklySummary(repositories: string[]): Promise<void> {
    logger.info(`📊 Generating weekly deployment summary for ${repositories.length} repositories`);

    try {
      const summaryData = {
        week: this.getCurrentWeekString(),
        repositories: repositories.length,
        timestamp: new Date().toISOString()
      };

      // Check activity for all repositories (last 7 days)
      for (const repo of repositories) {
        await publishMessage(
          'deployment-monitor',
          `<capability name="deployment_cheerleader" action="check_repo_activity" repo="${repo}" days="7" />`,
          'general',
          'Deployment Monitor',
          true
        );

        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Send summary header message
      const summaryMessage = this.generateWeeklySummaryMessage(summaryData);
      
      await publishMessage(
        'deployment-monitor',
        summaryMessage,
        'general',
        'Deployment Monitor',
        true
      );

    } catch (error) {
      logger.error('❌ Failed to generate weekly deployment summary:', error);
    }
  }

  private getDayOfWeekNumber(dayName: string): number {
    const days = {
      'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
      'thursday': 4, 'friday': 5, 'saturday': 6
    };
    return days[dayName.toLowerCase() as keyof typeof days] || 1; // Default to Monday
  }

  private getCurrentWeekString(): string {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Go to Sunday
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6); // Go to Saturday
    
    const formatDate = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    
    return `${formatDate(startOfWeek)} - ${formatDate(endOfWeek)}`;
  }

  private generateWeeklySummaryMessage(data: { week: string; repositories: number }): string {
    return `📊 **Weekly Deployment Summary** (${data.week})

🔍 Monitoring **${data.repositories}** repositories for deployment activity

⏰ Detailed repository reports incoming...

---
*This is an automated weekly summary from your Deployment Cheerleader! 🤖*`;
  }

  async updateConfiguration(newConfig: Partial<DeploymentMonitorConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    
    if (this.isInitialized) {
      logger.info('🔄 Deployment monitor configuration updated, reinitializing...');
      await this.shutdown();
      await this.initialize();
    }
  }

  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    logger.info('🛑 Shutting down deployment monitor...');

    try {
      // Remove scheduled tasks
      await schedulerService.removeTask('deployment-monitor-check');
      await schedulerService.removeTask('deployment-weekly-summary');
      
      this.isInitialized = false;
      logger.info('✅ Deployment monitor shut down successfully');
    } catch (error) {
      logger.error('❌ Failed to shut down deployment monitor:', error);
    }
  }
}

// Default configuration for Coach Artie's repositories
export const defaultDeploymentMonitorConfig: DeploymentMonitorConfig = {
  repositories: [
    'room302studio/coachartie2', // This repository
    // Add more repositories to monitor here
  ],
  checkInterval: '0 */4 * * *', // Every 4 hours
  weeklyReportDay: 'monday',
  weeklyReportTime: '09:00'
};

// Global deployment monitor instance
export let deploymentMonitor: DeploymentMonitor | null = null;

// Initialize the deployment monitor
export async function initializeDeploymentMonitor(config?: DeploymentMonitorConfig): Promise<void> {
  const finalConfig = config || defaultDeploymentMonitorConfig;
  
  if (deploymentMonitor) {
    await deploymentMonitor.shutdown();
  }
  
  deploymentMonitor = new DeploymentMonitor(finalConfig);
  await deploymentMonitor.initialize();
}

// Process scheduled deployment tasks
export async function processDeploymentTask(taskData: TaskData): Promise<void> {
  if (!deploymentMonitor) {
    logger.warn('⚠️ Deployment monitor not initialized, skipping task');
    return;
  }
  
  await deploymentMonitor.processScheduledTask(taskData);
}