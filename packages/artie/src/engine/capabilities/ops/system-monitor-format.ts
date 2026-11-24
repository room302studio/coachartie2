/**
 * Discord Rich Formatting Utilities
 * Creates visually appealing, styled messages for Discord
 */

interface ProgressBar {
  current: number;
  total: number;
  width?: number;
  style?: 'blocks' | 'dots' | 'bars';
}

interface StatusIndicator {
  status: 'success' | 'error' | 'warning' | 'info' | 'loading' | 'critical';
  message: string;
}

export class DiscordFormatter {
  /**
   * Create a progress bar using block characters
   */
  static createProgressBar(options: ProgressBar): string {
    const { current, total, width = 10, style = 'blocks' } = options;
    const percentage = Math.min(100, Math.max(0, (current / total) * 100));
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;

    const chars = {
      blocks: { filled: '█', empty: '░' },
      dots: { filled: '●', empty: '○' },
      bars: { filled: '━', empty: '─' },
    };

    const char = chars[style];
    const bar = char.filled.repeat(filled) + char.empty.repeat(empty);

    return `${bar} ${percentage.toFixed(0)}%`;
  }

  /**
   * Create a status indicator with emoji and styling
   */
  static createStatus(status: StatusIndicator): string {
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
      loading: '⏳',
      critical: '🚨',
    };

    return `${icons[status.status]} **${status.message}**`;
  }

  /**
   * Create a divider line
   */
  static createDivider(style: 'solid' | 'dashed' | 'dotted' = 'solid'): string {
    const styles = {
      solid: '━'.repeat(40),
      dashed: '╌'.repeat(40),
      dotted: '┈'.repeat(40),
    };
    return styles[style];
  }

  /**
   * Create a box around text
   */
  static createBox(title: string, content: string): string {
    const width = Math.max(title.length, ...content.split('\n').map((l) => l.length)) + 4;
    const top = '┏' + '━'.repeat(width - 2) + '┓';
    const bottom = '┗' + '━'.repeat(width - 2) + '┛';
    const titleLine = `┃ **${title}**`.padEnd(width - 1) + '┃';
    const contentLines = content
      .split('\n')
      .map((line) => `┃ ${line}`.padEnd(width - 1) + '┃')
      .join('\n');

    return `${top}\n${titleLine}\n${contentLines}\n${bottom}`;
  }

  /**
   * Create a key-value table
   */
  static createTable(data: Record<string, string | number>): string {
    const maxKeyLength = Math.max(...Object.keys(data).map((k) => k.length));
    const lines = Object.entries(data).map(([key, value]) => {
      const paddedKey = key.padEnd(maxKeyLength);
      return `  **${paddedKey}** │ ${value}`;
    });
    return lines.join('\n');
  }

  /**
   * Create a health meter (visual status indicator)
   */
  static createHealthMeter(percentage: number, label?: string): string {
    let emoji: string;
    let status: string;

    if (percentage >= 90) {
      emoji = '🟢';
      status = 'EXCELLENT';
    } else if (percentage >= 75) {
      emoji = '🟡';
      status = 'GOOD';
    } else if (percentage >= 50) {
      emoji = '🟠';
      status = 'WARNING';
    } else if (percentage >= 25) {
      emoji = '🔴';
      status = 'CRITICAL';
    } else {
      emoji = '💀';
      status = 'EMERGENCY';
    }

    const bar = this.createProgressBar({
      current: percentage,
      total: 100,
      width: 15,
      style: 'blocks',
    });

    if (label) {
      return `${emoji} **${label}**: ${bar} *${status}*`;
    }
    return `${emoji} ${bar} *${status}*`;
  }

  /**
   * Create a live event message (with timestamp)
   */
  static createLiveEvent(event: string, details?: string): string {
    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    let message = `⚡ **[${timestamp}]** ${event}`;
    if (details) {
      message += `\n   └─ ${details}`;
    }
    return message;
  }

  /**
   * Create a metrics dashboard
   */
  static createMetricsDashboard(metrics: Record<string, any>): string {
    let dashboard = '📊 **Metrics Dashboard**\n\n';

    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value === 'number') {
        if (key.toLowerCase().includes('percent') || key.toLowerCase().includes('%')) {
          dashboard += this.createHealthMeter(value, key) + '\n';
        } else {
          dashboard += `  **${key}**: ${value.toLocaleString()}\n`;
        }
      } else if (typeof value === 'object' && value.current && value.total) {
        dashboard += `  **${key}**: ${this.createProgressBar(value)}\n`;
      } else {
        dashboard += `  **${key}**: ${value}\n`;
      }
    }

    return dashboard;
  }

  /**
   * Create a service status grid
   */
  static createServiceGrid(
    services: Array<{ name: string; status: string; details?: string }>
  ): string {
    let grid = '🏥 **Service Status**\n\n';

    const statusEmoji = {
      running: '🟢',
      stopped: '🔴',
      warning: '🟡',
      unknown: '⚪',
      degraded: '🟠',
    };

    services.forEach((service) => {
      const emoji = statusEmoji[service.status as keyof typeof statusEmoji] || '⚪';
      grid += `${emoji} **${service.name.padEnd(15)}** │ ${service.status.toUpperCase()}`;
      if (service.details) {
        grid += ` │ ${service.details}`;
      }
      grid += '\n';
    });

    return grid;
  }

  /**
   * Create an alert banner
   */
  static createAlert(
    level: 'info' | 'success' | 'warning' | 'critical',
    message: string,
    actions?: string[]
  ): string {
    const styles = {
      info: { emoji: 'ℹ️', border: '━' },
      success: { emoji: '✅', border: '═' },
      warning: { emoji: '⚠️', border: '━' },
      critical: { emoji: '🚨', border: '▓' },
    };

    const style = styles[level];
    const width = 50;
    const border = style.border.repeat(width);

    let alert = `${border}\n`;
    alert += `${style.emoji} **${level.toUpperCase()}**: ${message}\n`;

    if (actions && actions.length > 0) {
      alert += `\n**Actions:**\n`;
      actions.forEach((action, i) => {
        alert += `  ${i + 1}. ${action}\n`;
      });
    }

    alert += border;

    return alert;
  }

  /**
   * Format capability execution result
   */
  static formatCapabilityResult(capabilityName: string, action: string, result: any): string {
    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    let formatted = `╭─ 🎯 **Capability Executed** ─────────────╮\n`;
    formatted += `│ Name: **${capabilityName}**\n`;
    formatted += `│ Action: **${action}**\n`;
    formatted += `│ Time: ${timestamp}\n`;

    if (result.success) {
      formatted += `│ Status: ✅ **SUCCESS**\n`;
    } else {
      formatted += `│ Status: ❌ **FAILED**\n`;
      if (result.error) {
        formatted += `│ Error: ${result.error}\n`;
      }
    }

    formatted += `╰─────────────────────────────────────────╯\n\n`;

    if (result.message) {
      formatted += result.message;
    }

    return formatted;
  }

  /**
   * Create a code block with syntax highlighting hint
   */
  static createCodeBlock(code: string, language: string = ''): string {
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }

  /**
   * Create a collapsible section (using Discord spoilers)
   */
  static createCollapsible(title: string, content: string): string {
    return `**${title}**\n||${content}||`;
  }
}
