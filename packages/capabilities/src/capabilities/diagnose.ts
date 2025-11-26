import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../services/capability-registry.js';

const execAsync = promisify(exec);

/**
 * Diagnose capability - understand what went wrong
 *
 * When errors happen, figuring out WHY is half the battle.
 * This capability helps investigate failures:
 * - Parse error messages
 * - Check logs
 * - Find related stack traces
 * - Suggest likely causes
 */

interface DiagnoseParams {
  action: 'error' | 'logs' | 'process' | 'network' | 'disk';
  error?: string;
  file?: string;
  service?: string;
  lines?: number;
}

// Execute in sandbox container
async function execInContainer(command: string, timeout: number = 15000) {
  const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';
  const dockerCommand = `docker exec -w /workspace ${containerName} /bin/bash -c ${JSON.stringify(command)}`;

  return await execAsync(dockerCommand, {
    timeout,
    maxBuffer: 1024 * 1024 * 2,
    env: process.env,
  });
}

// Safe exec
async function safeExec(command: string): Promise<string> {
  try {
    const { stdout } = await execInContainer(command);
    return stdout.trim();
  } catch (error: any) {
    return error.stdout?.trim() || error.stderr?.trim() || '';
  }
}

// Common error patterns and their likely causes
const errorPatterns: { pattern: RegExp; cause: string; suggestion: string }[] = [
  {
    pattern: /ENOENT|no such file|not found/i,
    cause: 'File or directory does not exist',
    suggestion: 'Check the path. Use search to find the correct file location.',
  },
  {
    pattern: /EACCES|permission denied/i,
    cause: 'Permission denied',
    suggestion: 'Check file permissions with ls -la. May need chmod.',
  },
  {
    pattern: /EADDRINUSE|address already in use/i,
    cause: 'Port is already in use',
    suggestion: 'Find what\'s using the port: lsof -i :PORT or kill the process.',
  },
  {
    pattern: /ECONNREFUSED|connection refused/i,
    cause: 'Service not running or wrong port',
    suggestion: 'Check if the service is running. Verify host and port.',
  },
  {
    pattern: /ETIMEDOUT|timeout/i,
    cause: 'Operation timed out',
    suggestion: 'Network issue or slow service. Check connectivity and increase timeout.',
  },
  {
    pattern: /cannot find module|module not found/i,
    cause: 'Missing dependency',
    suggestion: 'Run npm install or check the import path.',
  },
  {
    pattern: /syntax error|unexpected token/i,
    cause: 'Syntax error in code',
    suggestion: 'Check the file at the line number. Look for typos, missing brackets.',
  },
  {
    pattern: /type.*is not assignable|typescript/i,
    cause: 'TypeScript type error',
    suggestion: 'Check types match. May need type assertion or fix the data structure.',
  },
  {
    pattern: /null|undefined.*not.*object|cannot read propert/i,
    cause: 'Null/undefined reference',
    suggestion: 'Add null checks. Verify the variable is initialized before use.',
  },
  {
    pattern: /out of memory|heap|allocation failed/i,
    cause: 'Memory exhaustion',
    suggestion: 'Memory leak or large data. Check for unbounded arrays/objects.',
  },
  {
    pattern: /CORS|cross-origin|access-control/i,
    cause: 'CORS policy blocking request',
    suggestion: 'Configure CORS on the server or use a proxy.',
  },
  {
    pattern: /401|unauthorized/i,
    cause: 'Authentication failed',
    suggestion: 'Check credentials, tokens, or API keys.',
  },
  {
    pattern: /403|forbidden/i,
    cause: 'Access forbidden',
    suggestion: 'Check permissions. User may not have access to this resource.',
  },
  {
    pattern: /404|not found/i,
    cause: 'Resource not found',
    suggestion: 'Check the URL/endpoint. Resource may have been deleted or moved.',
  },
  {
    pattern: /500|internal server error/i,
    cause: 'Server-side error',
    suggestion: 'Check server logs. The bug is on the backend.',
  },
];

// Analyze an error message
function analyzeError(errorText: string): {
  causes: string[];
  suggestions: string[];
  stackInfo?: { file: string; line: number }[];
} {
  const causes: string[] = [];
  const suggestions: string[] = [];
  const stackInfo: { file: string; line: number }[] = [];

  // Check against known patterns
  for (const { pattern, cause, suggestion } of errorPatterns) {
    if (pattern.test(errorText)) {
      causes.push(cause);
      suggestions.push(suggestion);
    }
  }

  // Extract stack trace info
  const stackLines = errorText.match(/at\s+.*?[(\s]([^:\s]+):(\d+)/g);
  if (stackLines) {
    for (const line of stackLines.slice(0, 5)) {
      const match = line.match(/([^:\s(]+):(\d+)/);
      if (match) {
        stackInfo.push({ file: match[1], line: parseInt(match[2]) });
      }
    }
  }

  // If no matches, provide generic advice
  if (causes.length === 0) {
    causes.push('Unknown error type');
    suggestions.push('Read the full error message. Search for the specific error text.');
  }

  return { causes, suggestions, stackInfo };
}

export const diagnoseCapability: RegisteredCapability = {
  name: 'diagnose',
  emoji: '🔬',
  supportedActions: ['error', 'logs', 'process', 'network', 'disk'],
  description: `Understand what went wrong. When errors happen, diagnose helps investigate.

Actions:
- error: Analyze an error message (paste it in)
- logs: Check recent logs for errors
- process: Diagnose a failing process
- network: Check network/connectivity issues
- disk: Check disk space and file issues

When something fails, start here. Understand before fixing.`,
  requiredParams: [],
  examples: [
    // Analyze an error
    `<capability name="diagnose" action="error" error="Error: ENOENT: no such file or directory, open '/workspace/config.json'" />`,

    // Check logs
    '<capability name="diagnose" action="logs" />',
    '<capability name="diagnose" action="logs" file="/var/log/app.log" lines="50" />',

    // Process issues
    '<capability name="diagnose" action="process" service="node" />',

    // Network issues
    '<capability name="diagnose" action="network" />',

    // Disk issues
    '<capability name="diagnose" action="disk" />',
  ],

  handler: async (params: any, _content: string | undefined) => {
    const {
      action = 'error',
      error,
      file,
      service,
      lines = 30,
    } = params as DiagnoseParams;

    // Use error from params or from capability content
    const errorText = error || _content || '';

    logger.info(`Diagnose: ${action}`);

    try {
      switch (action) {
        case 'error': {
          if (!errorText) {
            return `Error: Provide the error message to analyze.
Usage: action="error" error="your error message here"`;
          }

          const analysis = analyzeError(errorText);

          const lines: string[] = ['Error Analysis:', ''];

          // Show likely causes
          lines.push('Likely causes:');
          analysis.causes.forEach((c, i) => {
            lines.push(`  ${i + 1}. ${c}`);
          });

          // Show suggestions
          lines.push('', 'Suggestions:');
          analysis.suggestions.forEach((s, i) => {
            lines.push(`  ${i + 1}. ${s}`);
          });

          // Show stack trace info if found
          if (analysis.stackInfo && analysis.stackInfo.length > 0) {
            lines.push('', 'Stack trace locations:');
            analysis.stackInfo.forEach((s) => {
              lines.push(`  ${s.file}:${s.line}`);
            });
            lines.push('', 'Use edit:read to examine these files.');
          }

          return lines.join('\n');
        }

        case 'logs': {
          const logLines: string[] = ['Recent log errors:', ''];

          // Check common log locations
          if (file) {
            const content = await safeExec(`tail -${lines} "${file}" 2>/dev/null`);
            if (content) {
              logLines.push(`=== ${file} ===`, content);
            } else {
              logLines.push(`Could not read ${file}`);
            }
          } else {
            // Check npm/node logs
            const npmDebug = await safeExec(`cat /workspace/npm-debug.log 2>/dev/null | tail -${lines}`);
            if (npmDebug) {
              logLines.push('=== npm-debug.log ===', npmDebug);
            }

            // Check for recent errors in any log files
            const recentErrors = await safeExec(
              `find /workspace -name "*.log" -mmin -30 -exec grep -l -i "error\\|exception\\|fail" {} \\; 2>/dev/null | head -5`
            );
            if (recentErrors) {
              logLines.push('', 'Log files with recent errors:');
              for (const logFile of recentErrors.split('\n').filter(Boolean)) {
                const errors = await safeExec(`grep -i "error\\|exception" "${logFile}" | tail -5`);
                if (errors) {
                  logLines.push(`\n=== ${logFile.replace('/workspace/', '')} ===`, errors);
                }
              }
            }

            // Check dmesg for system errors
            const dmesg = await safeExec('dmesg | grep -i "error\\|fail\\|killed" | tail -5');
            if (dmesg) {
              logLines.push('', '=== System (dmesg) ===', dmesg);
            }
          }

          if (logLines.length === 2) {
            logLines.push('No recent log errors found.');
          }

          return logLines.join('\n');
        }

        case 'process': {
          const lines: string[] = ['Process Diagnosis:', ''];

          if (service) {
            // Check specific service
            const procs = await safeExec(`pgrep -a "${service}" 2>/dev/null`);
            if (procs) {
              lines.push(`${service} processes:`, procs);

              // Get more details
              const pids = await safeExec(`pgrep "${service}" 2>/dev/null`);
              if (pids) {
                for (const pid of pids.split('\n').slice(0, 3)) {
                  const status = await safeExec(`cat /proc/${pid}/status 2>/dev/null | grep -E "State|VmRSS|Threads"`);
                  if (status) {
                    lines.push(`\nPID ${pid}:`, status);
                  }
                }
              }
            } else {
              lines.push(`No ${service} processes found.`);

              // Check if it crashed recently
              const zombies = await safeExec('ps aux | grep -E "Z|defunct"');
              if (zombies.includes('Z') || zombies.includes('defunct')) {
                lines.push('', 'Warning: Zombie processes detected:', zombies);
              }
            }
          } else {
            // General process health
            const topCpu = await safeExec('ps aux --sort=-%cpu | head -6');
            const topMem = await safeExec('ps aux --sort=-%mem | head -6');

            lines.push('Top CPU consumers:', topCpu);
            lines.push('', 'Top memory consumers:', topMem);

            // Check for zombie processes
            const zombies = await safeExec('ps aux | grep -E "Z" | grep -v grep');
            if (zombies) {
              lines.push('', 'Warning: Zombie processes:', zombies);
            }
          }

          return lines.join('\n');
        }

        case 'network': {
          const lines: string[] = ['Network Diagnosis:', ''];

          // Check listening ports
          const ports = await safeExec('ss -tlnp 2>/dev/null | head -15');
          lines.push('Listening ports:', ports || 'No listening ports');

          // Check connectivity
          const ping = await safeExec('ping -c 1 -W 2 8.8.8.8 2>&1');
          lines.push('', 'External connectivity:');
          if (ping.includes('1 received')) {
            lines.push('  ✓ Internet reachable');
          } else {
            lines.push('  ✗ Internet unreachable');
          }

          // DNS check
          const dns = await safeExec('nslookup google.com 2>&1 | head -5');
          lines.push('', 'DNS:', dns.includes('Address') ? '  ✓ DNS working' : '  ✗ DNS issues');

          // Active connections
          const conns = await safeExec('ss -tn state established 2>/dev/null | head -10');
          if (conns) {
            lines.push('', 'Active connections:', conns);
          }

          return lines.join('\n');
        }

        case 'disk': {
          const lines: string[] = ['Disk Diagnosis:', ''];

          // Disk space
          const df = await safeExec('df -h /workspace /tmp 2>/dev/null');
          lines.push('Disk space:', df);

          // Large files
          const largeFiles = await safeExec(
            'find /workspace -type f -size +50M -exec ls -lh {} \\; 2>/dev/null | head -10'
          );
          if (largeFiles) {
            lines.push('', 'Large files (>50MB):', largeFiles);
          }

          // Inode usage
          const inodes = await safeExec('df -i /workspace 2>/dev/null');
          lines.push('', 'Inode usage:', inodes);

          // Recent large writes
          const recentLarge = await safeExec(
            'find /workspace -type f -mmin -10 -size +1M -exec ls -lh {} \\; 2>/dev/null | head -5'
          );
          if (recentLarge) {
            lines.push('', 'Recently modified large files:', recentLarge);
          }

          return lines.join('\n');
        }

        default:
          return `Unknown action: ${action}
Available: error, logs, process, network, disk`;
      }
    } catch (error: any) {
      logger.error(`Diagnose failed:`, { action, error: error.message });
      return `Diagnose error: ${error.message}`;
    }
  },
};
