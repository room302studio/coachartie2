import { readFile, writeFile, access, mkdir, copyFile } from 'fs/promises';
import { join, resolve, dirname, basename } from 'path';
import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

interface EnvParams {
  action?: string;
  file?: string;
  filename?: string;
  key?: string;
  name?: string;
  value?: string;
  variables?: Record<string, string> | string[];
  required?: string[];
}

interface NodeError extends Error {
  code?: string;
}

/**
 * Environment Variable Management Capability
 *
 * This capability provides secure and comprehensive environment variable management
 * for CoachArtie, allowing autonomous management of API keys and configuration.
 *
 * Supported actions:
 * - read_env: Read current environment variables from .env files
 * - set_env: Set environment variables in .env files
 * - create_env_file: Create new .env files
 * - backup_env: Backup existing .env files
 * - validate_env: Check required environment variables
 *
 * Security features:
 * - Only allows operations within the project directory
 * - Masks sensitive values in logs
 * - Creates backups before modifications
 * - Validates file paths and content
 */

// Define the project root directory (go up from packages/capabilities/src/capabilities to monorepo root)
const PROJECT_ROOT = resolve(dirname(import.meta.url.replace('file://', '')), '../../../../');

// Common sensitive environment variable patterns
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /key/i,
  /token/i,
  /api_key/i,
  /auth/i,
  /private/i,
  /credential/i,
  /dsn/i,
  /connection/i,
  /url.*database/i,
  /database.*url/i,
];

// Supported .env file types
const SUPPORTED_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.staging',
  '.env.example',
];

/**
 * Masks sensitive values for logging
 */
function maskSensitiveValue(key: string, value: string): string {
  const isSensitive = SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
  if (isSensitive && value.length > 4) {
    return value.substring(0, 4) + '*'.repeat(Math.min(value.length - 4, 8));
  }
  return value;
}

/**
 * Validates that a file path is within the project directory
 */
function validatePath(filePath: string): string {
  const resolvedPath = resolve(filePath);
  const projectRoot = resolve(PROJECT_ROOT);

  if (!resolvedPath.startsWith(projectRoot)) {
    throw new Error(`Access denied: Path must be within project directory. Got: ${resolvedPath}`);
  }

  return resolvedPath;
}

/**
 * Validates .env file name
 */
function validateEnvFileName(fileName: string): void {
  if (!SUPPORTED_ENV_FILES.includes(fileName)) {
    throw new Error(
      `Invalid .env file name: ${fileName}. ` + `Supported files: ${SUPPORTED_ENV_FILES.join(', ')}`
    );
  }
}

/**
 * Parses .env file content into key-value pairs
 */
function parseEnvContent(content: string): Record<string, string> {
  const envVars: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    // Parse KEY=VALUE format
    const equalIndex = trimmedLine.indexOf('=');
    if (equalIndex === -1) {
      continue; // Skip invalid lines
    }

    const key = trimmedLine.substring(0, equalIndex).trim();
    let value = trimmedLine.substring(equalIndex + 1).trim();

    // Remove quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    envVars[key] = value;
  }

  return envVars;
}

/**
 * Formats environment variables as .env file content
 */
function formatEnvContent(envVars: Record<string, string>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(envVars)) {
    // Quote values that contain spaces or special characters
    const needsQuotes = /[\s#"'\\]/.test(value);
    const quotedValue = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
    lines.push(`${key}=${quotedValue}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Reads environment variables from a .env file
 */
async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const validatedPath = validatePath(filePath);
    const content = await readFile(validatedPath, 'utf-8');
    return parseEnvContent(content);
  } catch (error) {
    if ((error as NodeError).code === 'ENOENT') {
      return {}; // File doesn't exist, return empty object
    }
    throw error;
  }
}

/**
 * Writes environment variables to a .env file
 */
async function writeEnvFile(filePath: string, envVars: Record<string, string>): Promise<void> {
  const validatedPath = validatePath(filePath);
  const content = formatEnvContent(envVars);

  // Ensure directory exists
  const dir = dirname(validatedPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory might already exist, ignore error
  }

  await writeFile(validatedPath, content, 'utf-8');
}

/**
 * Creates a backup of an existing .env file
 */
async function createBackup(filePath: string): Promise<string> {
  const validatedPath = validatePath(filePath);

  try {
    await access(validatedPath);
  } catch {
    // File doesn't exist, no backup needed
    return '';
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${validatedPath}.backup-${timestamp}`;

  await copyFile(validatedPath, backupPath);
  return backupPath;
}

/**
 * Environment management capability handler
 */
async function handleEnvironmentAction(params: any, content?: string): Promise<string> {
  const { action } = params;

  try {
    switch (action) {
      case 'read_env':
        return await handleReadEnv(params, content);

      case 'set_env':
        return await handleSetEnv(params, content);

      case 'create_env_file':
        return await handleCreateEnvFile(params, content);

      case 'backup_env':
        return await handleBackupEnv(params, content);

      case 'validate_env':
        return await handleValidateEnv(params, content);

      default:
        throw new Error(
          `Unknown environment action: ${action}\n\n` +
          `Available actions: read_env, set_env, create_env_file, backup_env, validate_env\n\n` +
          `Supported files: .env, .env.local, .env.development, .env.production, .env.test, .env.staging, .env.example\n\n` +
          `Examples:\n` +
          `• <capability name="environment" action="read_env" />\n` +
          `• <capability name="environment" action="set_env" key="API_KEY" value="secret" />\n` +
          `• <capability name="environment" action="validate_env" required="API_KEY,DATABASE_URL" />`
        );
    }
  } catch (error) {
    logger.error(`Environment capability error for action '${action}':`, error);
    throw error;
  }
}

/**
 * Handle read_env action
 */
async function handleReadEnv(params: EnvParams, _content?: string): Promise<string> {
  const fileName = params.file || params.filename || '.env';
  validateEnvFileName(fileName);

  const filePath = join(PROJECT_ROOT, fileName);

  logger.info(`📖 Reading environment variables from ${fileName}`);

  const envVars = await readEnvFile(filePath);
  const varCount = Object.keys(envVars).length;

  if (varCount === 0) {
    return `No environment variables found in ${fileName}`;
  }

  // Create a summary with masked sensitive values
  const summary = Object.entries(envVars)
    .map(([key, value]) => `${key}=${maskSensitiveValue(key, value)}`)
    .join('\n');

  logger.info(`✅ Read ${varCount} environment variables from ${fileName}`);

  return `Environment variables from ${fileName} (${varCount} variables):\n${summary}`;
}

/**
 * Handle set_env action
 */
async function handleSetEnv(params: EnvParams, content?: string): Promise<string> {
  const fileName = params.file || params.filename || '.env';
  validateEnvFileName(fileName);

  const key = params.key || params.name;
  const value = params.value || content;

  if (!key) {
    throw new Error('Environment variable key is required');
  }

  if (value === undefined) {
    throw new Error('Environment variable value is required');
  }

  const filePath = join(PROJECT_ROOT, fileName);

  logger.info(`🔧 Setting environment variable ${key} in ${fileName}`);

  // Create backup before modifying
  const backupPath = await createBackup(filePath);
  if (backupPath) {
    logger.info(`📋 Created backup: ${basename(backupPath)}`);
  }

  // Read existing variables
  const envVars = await readEnvFile(filePath);

  // Set the new variable
  const oldValue = envVars[key];
  envVars[key] = value;

  // Write back to file
  await writeEnvFile(filePath, envVars);

  const maskedValue = maskSensitiveValue(key, value);
  const operation = oldValue ? 'updated' : 'added';

  logger.info(`✅ Environment variable ${key} ${operation} in ${fileName}`);

  return (
    `Environment variable ${key}=${maskedValue} ${operation} in ${fileName}` +
    (backupPath ? `\nBackup created: ${basename(backupPath)}` : '')
  );
}

/**
 * Handle create_env_file action
 */
async function handleCreateEnvFile(params: EnvParams, content?: string): Promise<string> {
  const fileName = params.file || params.filename;

  if (!fileName) {
    throw new Error('File name is required for create_env_file action');
  }

  validateEnvFileName(fileName);

  const filePath = join(PROJECT_ROOT, fileName);

  logger.info(`📄 Creating new .env file: ${fileName}`);

  // Check if file already exists
  try {
    await access(filePath);
    throw new Error(`File ${fileName} already exists. Use set_env to modify existing files.`);
  } catch (error) {
    if ((error as NodeError).code !== 'ENOENT') {
      throw error; // Re-throw if it's not a "file not found" error
    }
  }

  // Parse initial content if provided
  let initialVars: Record<string, string> = {};
  if (content) {
    initialVars = parseEnvContent(content);
  }

  // Add any variables from params
  if (params.variables && typeof params.variables === 'object') {
    Object.assign(initialVars, params.variables);
  }

  // Write the new file
  await writeEnvFile(filePath, initialVars);

  const varCount = Object.keys(initialVars).length;

  logger.info(`✅ Created ${fileName} with ${varCount} environment variables`);

  return (
    `Created ${fileName} successfully` +
    (varCount > 0 ? ` with ${varCount} environment variables` : '')
  );
}

/**
 * Handle backup_env action
 */
async function handleBackupEnv(params: EnvParams, _content?: string): Promise<string> {
  const fileName = params.file || params.filename || '.env';
  validateEnvFileName(fileName);

  const filePath = join(PROJECT_ROOT, fileName);

  logger.info(`💾 Creating backup of ${fileName}`);

  const backupPath = await createBackup(filePath);

  if (!backupPath) {
    return `No backup created: ${fileName} does not exist`;
  }

  logger.info(`✅ Backup created: ${basename(backupPath)}`);

  return `Backup created successfully: ${basename(backupPath)}`;
}

/**
 * Handle validate_env action
 */
async function handleValidateEnv(params: EnvParams, _content?: string): Promise<string> {
  const fileName = params.file || params.filename || '.env';
  validateEnvFileName(fileName);

  const requiredVars = params.required || params.variables;

  if (!requiredVars || !Array.isArray(requiredVars)) {
    throw new Error('Required variables list is required for validation');
  }

  const filePath = join(PROJECT_ROOT, fileName);

  logger.info(`✅ Validating required environment variables in ${fileName}`);

  const envVars = await readEnvFile(filePath);
  const missingVars: string[] = [];
  const presentVars: string[] = [];

  for (const varName of requiredVars) {
    if (envVars[varName] && envVars[varName].trim() !== '') {
      presentVars.push(varName);
    } else {
      missingVars.push(varName);
    }
  }

  const summary = [
    `Validation results for ${fileName}:`,
    `✅ Present (${presentVars.length}): ${presentVars.join(', ') || 'none'}`,
    `❌ Missing (${missingVars.length}): ${missingVars.join(', ') || 'none'}`,
  ].join('\n');

  if (missingVars.length > 0) {
    logger.warn(`Missing required environment variables: ${missingVars.join(', ')}`);
  } else {
    logger.info(`✅ All required environment variables are present`);
  }

  return summary;
}

/**
 * Environment capability definition
 */
export const environmentCapability: RegisteredCapability = {
  name: 'environment',
  supportedActions: ['read_env', 'set_env', 'create_env_file', 'backup_env', 'validate_env'],
  description: 'Manages environment variables and .env files securely within the project directory',
  handler: handleEnvironmentAction,
};
