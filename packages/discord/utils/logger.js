import fetch from 'node-fetch';

export class Logger {
  constructor() {
    try {
      console.log('Initializing logger...');
      this.baseUrl = process.env.LOKI_HOST;
      this.basicAuth = process.env.LOKI_BASIC_AUTH;
      this.defaultLabels = {
        job: process.env.LOKI_JOB_NAME || 'coach-artie',
        environment: process.env.LOKI_ENVIRONMENT || 'development',
        component: process.env.LOKI_COMPONENT || 'discord',
      };

      // Log initial configuration
      console.log('📝 Logging Configuration:');
      console.log(`   - Log Level: ${process.env.LOG_LEVEL || 'info'}`);
      console.log(`   - Environment: ${this.defaultLabels.environment}`);
      console.log(`   - Loki Job Name: ${this.defaultLabels.job}`);
      console.log(`   - Loki Component: ${this.defaultLabels.component}`);
      console.log(`   - Loki Environment: ${this.defaultLabels.environment}`);
      console.log(`   - Loki Host: ${this.baseUrl}`);
      console.log('   - Local Logs: Enabled');

      // Test Loki connection
      this.testLokiConnection();

      console.log('Logger initialized successfully');
    } catch (error) {
      console.error('Failed to initialize logger:', error);
      // Don't throw, we want the logger to still work even if initialization fails
      this.initError = error;
    }
  }

  async testLokiConnection() {
    try {
      const response = await fetch(`${this.baseUrl}/ready`, {
        method: 'GET',
        headers: {
          ...(this.basicAuth && { Authorization: `Basic ${this.basicAuth}` }),
        },
      });

      if (!response.ok) {
        console.warn(`⚠️ Loki connection test failed: ${response.statusText}`);
      } else {
        console.log('✅ Loki connection test successful');
      }
    } catch (error) {
      console.warn('⚠️ Failed to connect to Loki:', error.message);
    }
  }

  async log(level, message, error = null, meta = {}) {
    // Always log to console first
    console.log(`[${level.toUpperCase()}] ${message}`, error || '', meta);

    // If initialization failed, just return after console.log
    if (this.initError) {
      return;
    }

    const timestamp = Date.now() + '000000'; // Nanosecond precision as required by Loki

    const logEntry = {
      message,
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      ...(error && {
        error:
          typeof error === 'string'
            ? error
            : {
                message: error.message,
                stack: error.stack,
                name: error.name,
                code: error.code,
              },
      }),
      ...(Object.keys(meta).length > 0 && { meta }),
    };

    const payload = {
      streams: [
        {
          stream: {
            ...this.defaultLabels,
            level: level.toUpperCase(),
          },
          values: [[timestamp, JSON.stringify(logEntry)]],
        },
      ],
    };

    try {
      const response = await fetch(`${this.baseUrl}/loki/api/v1/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.basicAuth && { Authorization: `Basic ${this.basicAuth}` }),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`Failed to send log to Loki: ${response.statusText}`);
        const responseText = await response.text();
        console.error('Loki response:', responseText);
      }
    } catch (err) {
      console.error('Error sending log to Loki:', err);
    }
  }

  // Convenience methods for different log levels
  async error(message, error = null, meta = {}) {
    return this.log('error', message, error, meta);
  }

  async warn(message, meta = {}) {
    return this.log('warn', message, null, meta);
  }

  async info(message, meta = {}) {
    return this.log('info', message, null, meta);
  }

  async debug(message, meta = {}) {
    return this.log('debug', message, null, meta);
  }
}

// Create and export a singleton instance
export const logger = new Logger();

// Example usage:
// await logger.error(
//   'Failed to send message to Discord channel',
//   'Invalid Permissions',
//   {
//     channel_id: '123456789',
//     permissions_required: ['SEND_MESSAGES']
//   }
// );
