import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

interface NodeError extends Error {
  code?: string;
}

/**
 * Filesystem capability - manages files and directories autonomously
 *
 * Supported actions:
 * - read_file: Read contents of a file
 * - write_file: Write/create a file with content
 * - create_directory: Create a directory (and parent directories if needed)
 * - list_directory: List contents of a directory
 * - exists: Check if a file or directory exists
 * - delete: Delete a file or directory
 *
 * Security Features:
 * - Only allows operations within the project directory
 * - Prevents access to sensitive system files
 * - Path validation and sanitization
 * - Comprehensive error handling
 *
 * Parameters:
 * - path: The file or directory path (required for all actions)
 * - content: The content to write (required for write_file action)
 * - recursive: Whether to create parent directories or delete recursively (optional)
 */

// Get the project root directory (where the packages folder is located)
const PROJECT_ROOT = path.resolve(process.cwd(), '../..');

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
 * Writes content to a file (creates if doesn't exist)
 */
async function writeFile(filePath: string, content: string): Promise<string> {
  const validPath = validateAndSanitizePath(filePath);

  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(validPath);
    await fs.mkdir(parentDir, { recursive: true });

    await fs.writeFile(validPath, content, 'utf-8');
    const relativePath = path.relative(PROJECT_ROOT, validPath);

    logger.info(`📝 Wrote file: ${relativePath} (${content.length} characters)`);
    return `Successfully wrote ${content.length} characters to ${relativePath}`;
  } catch (error) {
    const relativePath = path.relative(PROJECT_ROOT, validPath);
    throw new Error(`Failed to write file ${relativePath}: ${(error as Error).message}`);
  }
}

/**
 * Appends content to a file (creates if doesn't exist)
 */
async function appendFile(filePath: string, content: string): Promise<string> {
  const validPath = validateAndSanitizePath(filePath);

  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(validPath);
    await fs.mkdir(parentDir, { recursive: true });

    await fs.appendFile(validPath, content, 'utf-8');
    const relativePath = path.relative(PROJECT_ROOT, validPath);

    logger.info(`📝 Appended to file: ${relativePath} (${content.length} characters)`);
    return `Successfully appended ${content.length} characters to ${relativePath}`;
  } catch (error) {
    const relativePath = path.relative(PROJECT_ROOT, validPath);
    throw new Error(`Failed to append to file ${relativePath}: ${(error as Error).message}`);
  }
}

/**
 * Creates a directory (and parent directories if needed)
 */
async function createDirectory(dirPath: string, recursive: boolean = true): Promise<string> {
  const validPath = validateAndSanitizePath(dirPath);

  try {
    await fs.mkdir(validPath, { recursive });
    const relativePath = path.relative(PROJECT_ROOT, validPath);

    logger.info(`📁 Created directory: ${relativePath}`);
    return `Successfully created directory: ${relativePath}`;
  } catch (error) {
    if ((error as NodeError).code === 'EEXIST') {
      const relativePath = path.relative(PROJECT_ROOT, validPath);
      return `Directory already exists: ${relativePath}`;
    }
    const relativePath = path.relative(PROJECT_ROOT, validPath);
    throw new Error(`Failed to create directory ${relativePath}: ${(error as Error).message}`);
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

/**
 * Deletes a file or directory
 */
async function deleteFileOrDirectory(
  targetPath: string,
  recursive: boolean = false
): Promise<string> {
  const validPath = validateAndSanitizePath(targetPath);

  try {
    const stats = await fs.stat(validPath);
    const relativePath = path.relative(PROJECT_ROOT, validPath);

    if (stats.isDirectory()) {
      if (recursive) {
        await fs.rm(validPath, { recursive: true, force: true });
        logger.info(`🗑️ Deleted directory recursively: ${relativePath}`);
        return `Successfully deleted directory and all contents: ${relativePath}`;
      } else {
        await fs.rmdir(validPath);
        logger.info(`🗑️ Deleted empty directory: ${relativePath}`);
        return `Successfully deleted empty directory: ${relativePath}`;
      }
    } else {
      await fs.unlink(validPath);
      logger.info(`🗑️ Deleted file: ${relativePath}`);
      return `Successfully deleted file: ${relativePath}`;
    }
  } catch (error) {
    if ((error as NodeError).code === 'ENOENT') {
      throw new Error(`Path not found: ${path.relative(PROJECT_ROOT, validPath)}`);
    }
    if ((error as NodeError).code === 'ENOTEMPTY') {
      throw new Error(
        `Directory not empty (use recursive=true to delete contents): ${path.relative(PROJECT_ROOT, validPath)}`
      );
    }
    const relativePath = path.relative(PROJECT_ROOT, validPath);
    throw new Error(`Failed to delete ${relativePath}: ${(error as Error).message}`);
  }
}

export const filesystemCapability: RegisteredCapability = {
  name: 'filesystem',
  emoji: '📁',
  supportedActions: [
    'read_file',
    'write_file',
    'append_file',
    'create_directory',
    'list_directory',
    'exists',
    'delete',
  ],
  description: 'Manages files and directories autonomously with security restrictions',
  requiredParams: ['path'],
  handler: async (params, content) => {
    const { action, path: filePath, recursive } = params;

    if (!filePath) {
      throw new Error('Path parameter is required for all filesystem operations');
    }

    logger.info(`💾 Executing filesystem operation: ${action} on ${filePath}`);

    try {
      switch (action) {
        case 'read_file':
          return await readFile(filePath);

        case 'write_file': {
          const writeContent = params.content || content;
          if (!writeContent) {
            throw new Error('Content is required for write_file operation');
          }
          return await writeFile(filePath, writeContent);
        }

        case 'append_file': {
          const appendContent = params.content || content;
          if (!appendContent) {
            throw new Error('Content is required for append_file operation');
          }
          return await appendFile(filePath, appendContent);
        }

        case 'create_directory':
          return await createDirectory(filePath, recursive !== false);

        case 'list_directory':
          return await listDirectory(filePath);

        case 'exists':
          return await exists(filePath);

        case 'delete':
          return await deleteFileOrDirectory(filePath, recursive === true);

        default:
          throw new Error(`Unknown filesystem action: ${action}`);
      }
    } catch (error) {
      logger.error(`❌ Filesystem operation failed: ${action} on ${filePath}`, error);
      throw error;
    }
  },
};
