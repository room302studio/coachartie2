import { logger } from '@coachartie/shared';

/**
 * Slack Rich Formatting Utilities
 * Creates visually appealing, styled messages for Slack using mrkdwn
 */

export interface ProgressBar {
  current: number;
  total: number;
  width?: number;
  style?: 'blocks' | 'dots' | 'bars';
}

export interface StatusIndicator {
  status: 'success' | 'error' | 'warning' | 'info' | 'loading' | 'critical';
  message: string;
}

export interface FieldSection {
  name: string;
  value: string;
  inline?: boolean;
}

export interface RichMessage {
  title?: string;
  description?: string;
  fields?: FieldSection[];
  footer?: string;
  color?: 'green' | 'red' | 'yellow' | 'blue' | 'purple' | 'orange';
  timestamp?: boolean;
}

export class SlackFormatter {
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
   * Note: Slack uses *text* for bold in mrkdwn
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

    return `${icons[status.status]} *${status.message}*`;
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
    const titleLine = `┃ *${title}*`.padEnd(width - 1) + '┃';
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
      return `  *${paddedKey}* │ ${value}`;
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
      return `${emoji} *${label}*: ${bar} _${status}_`;
    }
    return `${emoji} ${bar} _${status}_`;
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

    let message = `⚡ *[${timestamp}]* ${event}`;
    if (details) {
      message += `\n   └─ ${details}`;
    }
    return message;
  }

  /**
   * Create a metrics dashboard
   */
  static createMetricsDashboard(metrics: Record<string, any>): string {
    let dashboard = '📊 *Metrics Dashboard*\n\n';

    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value === 'number') {
        if (key.toLowerCase().includes('percent') || key.toLowerCase().includes('%')) {
          dashboard += this.createHealthMeter(value, key) + '\n';
        } else {
          dashboard += `  *${key}*: ${value.toLocaleString()}\n`;
        }
      } else if (typeof value === 'object' && value.current && value.total) {
        dashboard += `  *${key}*: ${this.createProgressBar(value)}\n`;
      } else {
        dashboard += `  *${key}*: ${value}\n`;
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
    let grid = '🏥 *Service Status*\n\n';

    const statusEmoji = {
      running: '🟢',
      stopped: '🔴',
      warning: '🟡',
      unknown: '⚪',
      degraded: '🟠',
    };

    services.forEach((service) => {
      const emoji = statusEmoji[service.status as keyof typeof statusEmoji] || '⚪';
      grid += `${emoji} *${service.name.padEnd(15)}* │ ${service.status.toUpperCase()}`;
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
    alert += `${style.emoji} *${level.toUpperCase()}*: ${message}\n`;

    if (actions && actions.length > 0) {
      alert += `\n*Actions:*\n`;
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

    let formatted = `╭─ 🎯 *Capability Executed* ─────────────╮\n`;
    formatted += `│ Name: *${capabilityName}*\n`;
    formatted += `│ Action: *${action}*\n`;
    formatted += `│ Time: ${timestamp}\n`;

    if (result.success) {
      formatted += `│ Status: ✅ *SUCCESS*\n`;
    } else {
      formatted += `│ Status: ❌ *FAILED*\n`;
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
   * Slack supports triple backticks with language identifier
   */
  static createCodeBlock(code: string, language: string = ''): string {
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }

  /**
   * Create a collapsible section (Slack doesn't have native collapsible, so we use a quoted section)
   */
  static createCollapsible(title: string, content: string): string {
    return `*${title}*\n> ${content.split('\n').join('\n> ')}`;
  }

  /**
   * Create a bulleted list
   */
  static createList(items: string[], ordered: boolean = false): string {
    return items
      .map((item, index) => {
        const bullet = ordered ? `${index + 1}.` : '•';
        return `${bullet} ${item}`;
      })
      .join('\n');
  }

  /**
   * Create inline code formatting
   */
  static inlineCode(text: string): string {
    return `\`${text}\``;
  }

  /**
   * Create bold text
   */
  static bold(text: string): string {
    return `*${text}*`;
  }

  /**
   * Create italic text
   */
  static italic(text: string): string {
    return `_${text}_`;
  }

  /**
   * Create strikethrough text
   */
  static strikethrough(text: string): string {
    return `~${text}~`;
  }

  /**
   * Create a blockquote
   */
  static quote(text: string): string {
    return text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  }

  /**
   * Mention a user by ID
   * @param userId - The Slack user ID
   */
  static mentionUser(userId: string): string {
    return `<@${userId}>`;
  }

  /**
   * Link to a channel by ID
   * @param channelId - The Slack channel ID
   */
  static mentionChannel(channelId: string): string {
    return `<#${channelId}>`;
  }

  /**
   * Create a formatted link
   * @param url - The URL to link to
   * @param text - Optional display text (if omitted, shows URL)
   */
  static link(url: string, text?: string): string {
    if (text) {
      return `<${url}|${text}>`;
    }
    return `<${url}>`;
  }

  /**
   * Mention @channel (notifies all active members)
   */
  static mentionChannel_All(): string {
    return '<!channel>';
  }

  /**
   * Mention @here (notifies all active members currently online)
   */
  static mentionHere(): string {
    return '<!here>';
  }

  /**
   * Mention @everyone (notifies all members)
   */
  static mentionEveryone(): string {
    return '<!everyone>';
  }

  /**
   * Create a thread-like structure
   */
  static createThread(
    parentMessage: string,
    replies: Array<{ author: string; message: string; timestamp?: Date }>
  ): string {
    let thread = `*Thread:*\n${parentMessage}\n\n`;

    replies.forEach((reply, index) => {
      const time = reply.timestamp
        ? reply.timestamp.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';
      const prefix = index === replies.length - 1 ? '└─' : '├─';
      thread += `${prefix} *${reply.author}*${time ? ` [${time}]` : ''}: ${reply.message}\n`;
    });

    return thread;
  }

  /**
   * Create a formatted error message
   */
  static createErrorMessage(error: Error | string, context?: string): string {
    const errorMsg = typeof error === 'string' ? error : error.message;
    const stack = typeof error === 'string' ? undefined : error.stack;

    let message = `❌ *Error*${context ? ` in ${context}` : ''}\n`;
    message += `> ${errorMsg}\n`;

    if (stack) {
      message += `\n_Stack trace:_\n${this.createCodeBlock(stack, 'javascript')}`;
    }

    return message;
  }

  /**
   * Create a success message
   */
  static createSuccessMessage(message: string, details?: Record<string, any>): string {
    let formatted = `✅ *Success*: ${message}\n`;

    if (details) {
      formatted += '\n' + this.createTable(details);
    }

    return formatted;
  }

  /**
   * Create a loading/pending message
   */
  static createLoadingMessage(message: string): string {
    return `⏳ ${message}...`;
  }

  /**
   * Create a section with header
   */
  static createSection(header: string, content: string): string {
    return `*${header}*\n${content}`;
  }

  /**
   * Create a two-column layout (approximation using spacing)
   */
  static createColumns(left: string, right: string, width: number = 30): string {
    const leftLines = left.split('\n');
    const rightLines = right.split('\n');
    const maxLines = Math.max(leftLines.length, rightLines.length);

    const lines: string[] = [];
    for (let i = 0; i < maxLines; i++) {
      const leftContent = (leftLines[i] || '').padEnd(width);
      const rightContent = rightLines[i] || '';
      lines.push(`${leftContent} │ ${rightContent}`);
    }

    return lines.join('\n');
  }

  /**
   * Format a timestamp in Slack's format
   * @param date - The date to format
   * @param format - Optional format string (e.g., '{date_short}', '{time}')
   */
  static formatTimestamp(date: Date, format: string = '{date_short_pretty} at {time}'): string {
    const timestamp = Math.floor(date.getTime() / 1000);
    return `<!date^${timestamp}^${format}|${date.toISOString()}>`;
  }

  /**
   * Create a button-like call to action (text-based, since Slack interactive components need Block Kit)
   */
  static createCTA(text: string, description?: string): string {
    let cta = `🔘 *${text}*`;
    if (description) {
      cta += `\n   ${description}`;
    }
    return cta;
  }

  /**
   * Create a warning message
   */
  static createWarningMessage(message: string, details?: string): string {
    let warning = `⚠️ *Warning*: ${message}`;
    if (details) {
      warning += `\n> ${details}`;
    }
    return warning;
  }

  /**
   * Create an info message
   */
  static createInfoMessage(message: string, details?: string): string {
    let info = `ℹ️ ${message}`;
    if (details) {
      info += `\n${details}`;
    }
    return info;
  }

  /**
   * Escape special Slack mrkdwn characters
   */
  static escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Create a multi-line preformatted text block (alternative to code block)
   */
  static createPreformatted(text: string): string {
    return `\`\`\`\n${text}\n\`\`\``;
  }
}
