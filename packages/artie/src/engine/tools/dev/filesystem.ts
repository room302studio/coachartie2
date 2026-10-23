import { promises as fs } from 'fs';
import path from 'path';
import { logger, REPO_ROOT } from '@coachartie/shared';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';

interface NodeError extends Error {
  code?: string;
}

/**
 * Filesystem capability - read-only access to the project tree
 *
 * Supported actions:
 * - read_file: Read contents of a file
 * - list_directory: List contents of a directory
 * - exists: Check if a file or directory exists
 *
 * Security Features:
 * - Only allows operations within the project directory
 * - Prevents access to sensitive system files
 * - Path validation and sanitization
 * - Comprehensive error handling
 *
 * Parameters:
 * - path: The file or directory path (required for all actions)
 */

// Get the project root directory (where the packages folder is located)
const PROJECT_ROOT = REPO_ROOT;

/**
 * Validates and sanitizes a file path to ensure it's within the project directory
 * @param inputPath - The input path to validate
 * @returns The sanitized absolute path
 * @throws Error if the path is invalid or outside the project directory
 */
function validateAndSanitizePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path is required and must be a string');
  }

  // Remove any dangerous characters or patterns
  const sanitized = inputPath.replace(/\.\.\//g, '').replace(/\.\./g, '');

  // Resolve to absolute path
  const absolutePath = path.resolve(PROJECT_ROOT, sanitized);

  // Ensure the path is within the project directory
  if (!absolutePath.startsWith(PROJECT_ROOT)) {
    throw new Error('Access denied: Path must be within the project directory');
  }

  // Prevent access to sensitive files
  const relativePath = path.relative(PROJECT_ROOT, absolutePath);
  const sensitivePatterns = [
    /^\.env$/i,
    /^\.env\./i,
    /^\.git\//i,
    /^node_modules\//i,
    /^\.ssh\//i,
    /^\.aws\//i,
    /^\.docker\//i,
    /package-lock\.json$/i,
    /yarn\.lock$/i,
    /pnpm-lock\.yaml$/i,
  ];

  // Secrets at any depth (packages/*/.env too) and the live DB behind the data/ symlink.
  const segments = relativePath.split(path.sep);
  if (segments.some((s) => s.startsWith('.env')) || segments[0] === 'data') {
    throw new Error(`Access denied: Cannot access sensitive file/directory: ${relativePath}`);
  }

  for (const pattern of sensitivePatterns) {
    if (pattern.test(relativePath)) {
      throw new Error(`Access denied: Cannot access sensitive file/directory: ${relativePath}`);
    }
  }

  return absolutePath;
}

/**
 * Reads the contents of a file
 */
async function readFile(filePath: string): Promise<string> {
  const validPath = validateAndSanitizePath(filePath);

  try {
    const stats = await fs.stat(validPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${path.relative(PROJECT_ROOT, validPath)}`);
    }

    // Prevent V8 crashes from large files (limit to 10MB)
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${path.relative(PROJECT_ROOT, validPath)} (${Math.round(stats.size / 1024 / 1024)}MB > 10MB limit)`
      );
    }

    // Use try-catch around actual file read to prevent V8 UTF-8 crashes
    let content: string;
    try {
      content = await fs.readFile(validPath, 'utf-8');
    } catch (encodingError) {
      logger.error(
        `UTF-8 encoding error reading file: ${path.relative(PROJECT_ROOT, validPath)}`,
        encodingError
      );
      throw new Error(
        `File encoding error: ${path.relative(PROJECT_ROOT, validPath)} - file may be corrupted or binary`
      );
    }

    const relativePath = path.relative(PROJECT_ROOT, validPath);

    logger.info(`📖 Read file: ${relativePath} (${content.length} characters)`);
    return `File content from ${relativePath}:\n${content}`;
  } catch (error) {
    if ((error as NodeError).code === 'ENOENT') {
      throw new Error(`File not found: ${path.relative(PROJECT_ROOT, validPath)}`);
    }
    throw error;
  }
}

/**
 * Lists the contents of a directory
 */
async function listDirectory(dirPath: string): Promise<string> {
  const validPath = validateAndSanitizePath(dirPath);

  try {
    const stats = await fs.stat(validPath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${path.relative(PROJECT_ROOT, validPath)}`);
    }

    const items = await fs.readdir(validPath, { withFileTypes: true });
    const relativePath = path.relative(PROJECT_ROOT, validPath);

    if (items.length === 0) {
      return `Directory ${relativePath} is empty`;
    }

    const fileList = items
      .map((item) => {
        const type = item.isDirectory() ? '📁' : '📄';
        return `${type} ${item.name}`;
      })
      .join('\n');

    logger.info(`📋 Listed directory: ${relativePath} (${items.length} items)`);
    return `Contents of ${relativePath}:\n${fileList}`;
  } catch (error) {
    if ((error as NodeError).code === 'ENOENT') {
      throw new Error(`Directory not found: ${path.relative(PROJECT_ROOT, validPath)}`);
    }
    throw error;
  }
}

/**
 * Checks if a file or directory exists
 */
async function exists(targetPath: string): Promise<string> {
  const validPath = validateAndSanitizePath(targetPath);

  try {
    const stats = await fs.stat(validPath);
    const relativePath = path.relative(PROJECT_ROOT, validPath);
    const type = stats.isDirectory() ? 'directory' : 'file';

    logger.info(`✅ Checked existence: ${relativePath} (${type})`);
    return `${type.charAt(0).toUpperCase() + type.slice(1)} exists: ${relativePath}`;
  } catch (error) {
    if ((error as NodeError).code === 'ENOENT') {
      const relativePath = path.relative(PROJECT_ROOT, validPath);
      return `Path does not exist: ${relativePath}`;
    }
    throw error;
  }
}

export const filesystemCapability: RegisteredCapability = {
  name: 'filesystem',
  emoji: '📁',
  // Read-only. This runs on the production host (not the sandbox), so write/append/
  // create/delete were a way for any chat turn to change the bot's own code. Removed 2026-10-23.
  supportedActions: ['read_file', 'list_directory', 'exists'],
  description: 'Reads files and lists directories inside the project (read-only)',
  requiredParams: ['path'],
  handler: async (params, content) => {
    const { action, path: filePath } = params;

    if (!filePath) {
      throw new Error('Path parameter is required for all filesystem operations');
    }

    logger.info(`💾 Executing filesystem operation: ${action} on ${filePath}`);

    try {
      switch (action) {
        case 'read_file':
          return await readFile(filePath);

        case 'list_directory':
          return await listDirectory(filePath);

        case 'exists':
          return await exists(filePath);

        default:
          throw new Error(`Unknown filesystem action: ${action}`);
      }
    } catch (error) {
      logger.error(`❌ Filesystem operation failed: ${action} on ${filePath}`, error);
      throw error;
    }
  },
};
