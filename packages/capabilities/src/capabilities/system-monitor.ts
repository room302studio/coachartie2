import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { DiscordFormatter } from '../utils/discord-formatter.js';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * System Monitor Capability
 * Allows Artie to check system resources and service health in real-time
 */
export const systemMonitorCapability: RegisteredCapability = {
  name: 'system_monitor',
  supportedActions: [
    'get_resources',
    'check_services',
    'get_uptime',
    'check_disk',
    'health_summary',
  ],
  description: 'Monitor system resources, service health, and performance metrics',
  handler: async (params, content) => {
    const { action = 'get_resources' } = params;

    switch (action) {
      case 'get_resources':
        try {
          const totalMem = os.totalmem();
          const freeMem = os.freemem();
          const usedMem = totalMem - freeMem;
          const memPercentNum = ((usedMem / totalMem) * 100);
          const memPercent = memPercentNum.toFixed(1);

          const cpus = os.cpus();
          const loadAvg = os.loadavg();

          // Create visual health meter for memory
          const memHealth = DiscordFormatter.createHealthMeter(
            100 - memPercentNum,
            'Memory Available'
          );

          // Create metrics dashboard
          const metrics = {
            'Memory Used': `${(usedMem / 1024 / 1024 / 1024).toFixed(2)} GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
            'CPU Cores': cpus.length,
            'Load Average': loadAvg.map((l) => l.toFixed(2)).join(' • '),
          };

          let response = DiscordFormatter.createBox('System Resources', '');
          response += '\n\n';
          response += memHealth + '\n\n';
          response += DiscordFormatter.createTable(metrics);
          response += '\n\n';
          response += DiscordFormatter.createDivider('solid');
          response += '\n';
          response += `**Platform**: ${os.type()} ${os.release()} (${os.arch()})\n`;
          response += `**Hostname**: ${os.hostname()}`;

          // Add visual indicator for memory pressure
          const memStatus =
            memPercentNum > 90
              ? '🔴 CRITICAL'
              : memPercentNum > 75
                ? '🟡 WARNING'
                : '🟢 HEALTHY';

          return JSON.stringify({
            success: true,
            data: {
              memory: {
                total_gb: (totalMem / 1024 / 1024 / 1024).toFixed(2),
                used_gb: (usedMem / 1024 / 1024 / 1024).toFixed(2),
                free_gb: (freeMem / 1024 / 1024 / 1024).toFixed(2),
                percent: parseFloat(memPercent),
                status: memStatus,
              },
              cpu: {
                cores: cpus.length,
                model: cpus[0]?.model,
                load_avg: loadAvg,
              },
              platform: {
                type: os.type(),
                release: os.release(),
                arch: os.arch(),
                hostname: os.hostname(),
              },
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to get system resources:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve system resources',
          });
        }

      case 'check_services':
        try {
          const services = [
            { name: 'Discord', port: 47319 },
            { name: 'Redis', port: 47320 },
            { name: 'Capabilities', port: 47324 },
            { name: 'Brain UI', port: 47325 },
            { name: 'SMS', port: 47326 },
          ];

          const serviceStatus: any[] = [];

          for (const service of services) {
            try {
              const { stdout } = await execAsync(
                `lsof -i :${service.port} -sTCP:LISTEN -t 2>/dev/null || echo ""`
              );
              const isRunning = stdout.trim().length > 0;

              serviceStatus.push({
                name: service.name,
                port: service.port,
                status: isRunning ? 'running' : 'stopped',
                emoji: isRunning ? '✅' : '❌',
              });
            } catch {
              serviceStatus.push({
                name: service.name,
                port: service.port,
                status: 'unknown',
                emoji: '⚠️',
              });
            }
          }

          const runningCount = serviceStatus.filter((s) => s.status === 'running').length;
          const totalCount = serviceStatus.length;

          let response = '🏥 **Service Health:**\n\n';
          response += `**Status: ${runningCount}/${totalCount} services running**\n\n`;

          serviceStatus.forEach((service) => {
            response += `${service.emoji} ${service.name} (${service.port}): ${service.status}\n`;
          });

          return JSON.stringify({
            success: true,
            data: {
              services: serviceStatus,
              running_count: runningCount,
              total_count: totalCount,
              all_healthy: runningCount === totalCount,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to check services:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to check service health',
          });
        }

      case 'get_uptime':
        try {
          const uptimeSeconds = os.uptime();
          const uptimeDays = Math.floor(uptimeSeconds / 86400);
          const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
          const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);

          const processUptimeSeconds = process.uptime();
          const processUptimeMinutes = Math.floor(processUptimeSeconds / 60);
          const processUptimeHours = Math.floor(processUptimeMinutes / 60);

          let response = '⏱️ **Uptime:**\n\n';
          response += '**System:**\n';
          response += `  • ${uptimeDays}d ${uptimeHours}h ${uptimeMinutes}m\n\n`;
          response += '**Process (Capabilities):**\n';
          response += `  • ${processUptimeHours}h ${processUptimeMinutes % 60}m\n`;
          response += `  • PID: ${process.pid}`;

          return JSON.stringify({
            success: true,
            data: {
              system_uptime_seconds: uptimeSeconds,
              system_uptime_formatted: `${uptimeDays}d ${uptimeHours}h ${uptimeMinutes}m`,
              process_uptime_seconds: processUptimeSeconds,
              process_uptime_formatted: `${processUptimeHours}h ${processUptimeMinutes % 60}m`,
              process_pid: process.pid,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to get uptime:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve uptime',
          });
        }

      case 'check_disk':
        try {
          // Try to get disk usage via df command
          const { stdout } = await execAsync('df -h / | tail -1');
          const parts = stdout.trim().split(/\s+/);

          // df output: Filesystem Size Used Avail Capacity Mounted
          const diskInfo = {
            filesystem: parts[0],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            capacity: parts[4],
            mounted: parts[5],
          };

          let response = '💾 **Disk Usage:**\n\n';
          response += `**Root Filesystem (${diskInfo.mounted}):**\n`;
          response += `  • Total: ${diskInfo.size}\n`;
          response += `  • Used: ${diskInfo.used} (${diskInfo.capacity})\n`;
          response += `  • Available: ${diskInfo.available}\n`;

          const capacityNum = parseInt(diskInfo.capacity);
          const diskStatus =
            capacityNum > 90 ? '🔴 CRITICAL' : capacityNum > 75 ? '🟡 WARNING' : '🟢 HEALTHY';

          response += `\n**Status:** ${diskStatus}`;

          return JSON.stringify({
            success: true,
            data: {
              ...diskInfo,
              capacity_percent: capacityNum,
              status: diskStatus,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to check disk:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve disk usage',
          });
        }

      case 'health_summary':
        try {
          // Get all health metrics
          const totalMem = os.totalmem();
          const freeMem = os.freemem();
          const usedMem = totalMem - freeMem;
          const memPercent = ((usedMem / totalMem) * 100).toFixed(1);

          const loadAvg = os.loadavg();
          const cpuLoad = loadAvg[0]; // 1-minute average

          // Check services
          const services = [
            { name: 'Discord', port: 47319 },
            { name: 'Redis', port: 47320 },
            { name: 'Capabilities', port: 47324 },
          ];

          let runningServices = 0;
          for (const service of services) {
            try {
              const { stdout } = await execAsync(
                `lsof -i :${service.port} -sTCP:LISTEN -t 2>/dev/null || echo ""`
              );
              if (stdout.trim().length > 0) runningServices++;
            } catch {
              // Service check failed
            }
          }

          // Determine overall health
          const memHealth = parseFloat(memPercent) < 75;
          const cpuHealth = cpuLoad < os.cpus().length * 0.8;
          const servicesHealth = runningServices === services.length;

          const overallHealth = memHealth && cpuHealth && servicesHealth;

          // Create visual health summary
          const memHealthPercent = 100 - parseFloat(memPercent);
          const cpuHealthPercent = Math.max(0, 100 - (cpuLoad / os.cpus().length) * 100);

          let response = '';

          if (overallHealth) {
            response = DiscordFormatter.createAlert(
              'success',
              'ALL SYSTEMS NOMINAL',
              []
            );
          } else {
            const actions = [];
            if (!memHealth) actions.push('Memory high - consider restart or optimization');
            if (!cpuHealth) actions.push('CPU load high - may need to throttle operations');
            if (!servicesHealth) actions.push('Some services down - check logs and restart');

            response = DiscordFormatter.createAlert(
              'warning',
              'ISSUES DETECTED - Action Required',
              actions
            );
          }

          response += '\n\n';
          response += DiscordFormatter.createHealthMeter(memHealthPercent, 'Memory Health');
          response += '\n';
          response += DiscordFormatter.createHealthMeter(cpuHealthPercent, 'CPU Health');
          response += '\n\n';
          response += DiscordFormatter.createDivider('solid');
          response += '\n';
          response += `**Services Running**: ${runningServices}/${services.length} ${servicesHealth ? '✅' : '❌'}`;

          return JSON.stringify({
            success: true,
            data: {
              overall_health: overallHealth,
              memory: {
                percent: parseFloat(memPercent),
                healthy: memHealth,
              },
              cpu: {
                load: cpuLoad,
                healthy: cpuHealth,
              },
              services: {
                running: runningServices,
                total: services.length,
                healthy: servicesHealth,
              },
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to get health summary:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve health summary',
          });
        }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`,
        });
    }
  },
  examples: [
    '<capability name="system_monitor" action="get_resources" />',
    '<capability name="system_monitor" action="check_services" />',
    '<capability name="system_monitor" action="get_uptime" />',
    '<capability name="system_monitor" action="check_disk" />',
    '<capability name="system_monitor" action="health_summary" />',
  ],
};
