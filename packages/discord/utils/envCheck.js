export const requiredEnvVars = [
  'DISCORD_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_API_KEY',
  'WEBHOOK_SECRET',
  'CAPABILITIES_URL',
  'LOKI_HOST',
  'LOKI_BASIC_AUTH',
  'LOKI_JOB_NAME',
  'LOKI_COMPONENT',
];

export const optionalEnvVars = {
  LOG_LEVEL: 'info',
  NODE_ENV: 'development',
  LOKI_ENVIRONMENT: 'development',
  DISABLE_LOCAL_LOGS: 'false',
  PAPERTRAIL_HOST: '',
  PAPERTRAIL_PORT: '',
  LOKI_API_PATH: '/loki/api/v1/push',
};

export function checkEnvVars() {
  const missing = [];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  // Set defaults for optional vars if not present
  for (const [key, defaultValue] of Object.entries(optionalEnvVars)) {
    if (!process.env[key]) {
      process.env[key] = defaultValue;
    }
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
  }

  // Log the current logging configuration
  console.log('✅ Environment variables validated');
  console.log('📝 Logging Configuration:');
  console.log(`   - Log Level: ${process.env.LOG_LEVEL}`);
  console.log(`   - Environment: ${process.env.NODE_ENV}`);
  console.log(`   - Loki Job Name: ${process.env.LOKI_JOB_NAME}`);
  console.log(`   - Loki Component: ${process.env.LOKI_COMPONENT}`);
  console.log(`   - Loki Environment: ${process.env.LOKI_ENVIRONMENT}`);
  console.log(`   - Loki Host: ${process.env.LOKI_HOST}`);
  console.log(
    `   - Local Logs: ${
      process.env.DISABLE_LOCAL_LOGS === 'true' ? 'Disabled' : 'Enabled'
    }`
  );
  if (process.env.PAPERTRAIL_HOST && process.env.PAPERTRAIL_PORT) {
    console.log(`   - Papertrail Integration: Configured`);
  }

  return true;
}
