module.exports = {
  apps: [
    {
      name: 'capabilities',
      script: 'packages/capabilities/src/index.ts',
      interpreter: 'tsx',
      env: {
        NODE_ENV: 'development',
        CAPABILITIES_PORT: process.env.CAPABILITIES_PORT || 3001
      },
      watch: false, // Let nodemon handle watching
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G'
    },
    {
      name: 'discord',
      script: 'packages/discord/src/index.ts',
      interpreter: 'tsx',
      env: {
        NODE_ENV: 'development'
      },
      watch: false,
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M'
    },
    {
      name: 'sms',
      script: 'packages/sms/src/index.ts',
      interpreter: 'tsx',
      env: {
        NODE_ENV: 'development',
        SMS_PORT: process.env.SMS_PORT || 3002
      },
      watch: false,
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M'
    },
    {
      name: 'email',
      script: 'packages/email/src/index.ts',
      interpreter: 'tsx',
      env: {
        NODE_ENV: 'development',
        EMAIL_SERVICE_PORT: process.env.EMAIL_SERVICE_PORT || 3003
      },
      watch: false,
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M'
    }
  ]
};