import { spawn } from 'child_process';
import { readFile, writeFile, access, constants } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

interface NodeError extends Error {
  code?: string;
}

/**
 * Package Manager capability - manages npm packages and package.json files safely
 *
 * Supported actions:
 * - install_package: Install npm packages with pnpm
 * - create_package: Initialize new package.json
 * - run_script: Execute npm scripts
 * - check_dependencies: List installed packages
 * - update_package_json: Modify package.json files
 *
 * Safety restrictions:
 * - Only allows operations within project workspace
 * - Validates package names for security
 * - Prevents installation of dangerous packages
 */

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * List of potentially dangerous packages that should not be installed
 */
const DANGEROUS_PACKAGES = [
  'rimraf',
  'shelljs',
  'cross-spawn',
  'child-process-promise',
  // Add more dangerous packages as needed
];

/**
 * Get the project root directory (monorepo root)
 */
function getProjectRoot(): string {
  // Go up from packages/capabilities/src to monorepo root
  return resolve(process.cwd(), '../../../');
}

/**
 * Validate that a path is within the project workspace
 */
function validateWorkspacePath(targetPath: string): string {
  const projectRoot = getProjectRoot();
  const resolvedPath = resolve(targetPath);

  if (!resolvedPath.startsWith(projectRoot)) {
    throw new Error(
      `Path ${targetPath} is outside project workspace. Operations are restricted to project directory.`
    );
  }

  return resolvedPath;
}

/**
 * Validate package name for security
 */
function validatePackageName(packageName: string): void {
  // Check for dangerous packages
  if (DANGEROUS_PACKAGES.includes(packageName)) {
    throw new Error(`Package ${packageName} is restricted for security reasons`);
  }

  // Basic package name validation
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(packageName)) {
    throw new Error(`Invalid package name: ${packageName}`);
  }

  // Prevent shell injection attempts
  if (
    packageName.includes(';') ||
    packageName.includes('&') ||
    packageName.includes('|') ||
    packageName.includes('`')
  ) {
    throw new Error(`Package name contains invalid characters: ${packageName}`);
  }
}

/**
 * Execute pnpm command safely
 */
async function executePnpmCommand(command: string, workingDir: string): Promise<string> {
  const validatedDir = validateWorkspacePath(workingDir);

  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', command.split(' '), {
      cwd: validatedDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // Prevent shell injection
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`pnpm command failed: ${stderr || stdout}`));
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to execute pnpm: ${error.message}`));
    });
  });
}

/**
 * Read and parse package.json safely
 */
async function readPackageJson(packagePath: string): Promise<PackageJson> {
  const validatedPath = validateWorkspacePath(packagePath);
  const packageJsonPath = join(validatedPath, 'package.json');

  try {
    await access(packageJsonPath, constants.R_OK);
    const content = await readFile(packageJsonPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to read package.json at ${packageJsonPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Write package.json safely
 */
async function writePackageJson(packagePath: string, packageJson: PackageJson): Promise<void> {
  const validatedPath = validateWorkspacePath(packagePath);
  const packageJsonPath = join(validatedPath, 'package.json');

  try {
    const content = JSON.stringify(packageJson, null, 2) + '\n';
    await writeFile(packageJsonPath, content, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to write package.json at ${packageJsonPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Install npm packages
 */
async function installPackage(
  packageName: string,
  workingDir: string,
  isDev = false
): Promise<string> {
  validatePackageName(packageName);

  const flag = isDev ? '--save-dev' : '--save';
  const command = `install ${packageName} ${flag}`;

  logger.info(`📦 Installing package: ${packageName} in ${workingDir} (dev: ${isDev})`);

  try {
    await executePnpmCommand(command, workingDir);
    logger.info(`✅ Successfully installed ${packageName}`);
    return `Successfully installed ${packageName}${isDev ? ' as dev dependency' : ''}`;
  } catch (error) {
    logger.error(`❌ Failed to install ${packageName}:`, error);
    throw error;
  }
}

/**
 * Create new package.json
 */
async function createPackage(
  packagePath: string,
  options: Partial<PackageJson> = {}
): Promise<string> {
  const validatedPath = validateWorkspacePath(packagePath);
  const packageJsonPath = join(validatedPath, 'package.json');

  // Check if package.json already exists
  try {
    await access(packageJsonPath, constants.F_OK);
    throw new Error(`package.json already exists at ${packageJsonPath}`);
  } catch (error) {
    if ((error as NodeError).code !== 'ENOENT') {
      throw error;
    }
  }

  const defaultPackageJson: PackageJson = {
    name: options.name || dirname(validatedPath).split('/').pop() || 'new-package',
    version: options.version || '1.0.0',
    description: options.description || '',
    main: options.main || 'index.js',
    scripts: {
      test: 'echo "Error: no test specified" && exit 1',
      ...options.scripts,
    },
    dependencies: options.dependencies || {},
    devDependencies: options.devDependencies || {},
    ...options,
  };

  await writePackageJson(packagePath, defaultPackageJson);
  logger.info(`✅ Created package.json at ${packageJsonPath}`);

  return `Successfully created package.json for ${defaultPackageJson.name}`;
}

/**
 * Run npm script
 */
async function runScript(scriptName: string, workingDir: string): Promise<string> {
  const packageJson = await readPackageJson(workingDir);

  if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
    throw new Error(`Script "${scriptName}" not found in package.json`);
  }

  const command = `run ${scriptName}`;

  logger.info(`🏃 Running script: ${scriptName} in ${workingDir}`);

  try {
    const result = await executePnpmCommand(command, workingDir);
    logger.info(`✅ Successfully ran script ${scriptName}`);
    return `Script "${scriptName}" completed successfully:\n${result}`;
  } catch (error) {
    logger.error(`❌ Script ${scriptName} failed:`, error);
    throw error;
  }
}

/**
 * Check dependencies
 */
async function checkDependencies(workingDir: string): Promise<string> {
  try {
    const packageJson = await readPackageJson(workingDir);

    const deps = packageJson.dependencies || {};
    const devDeps = packageJson.devDependencies || {};
    const peerDeps = packageJson.peerDependencies || {};

    let result = `Dependencies for ${packageJson.name || 'package'}:\n\n`;

    if (Object.keys(deps).length > 0) {
      result += `Production Dependencies (${Object.keys(deps).length}):\n`;
      Object.entries(deps).forEach(([name, version]) => {
        result += `  - ${name}: ${version}\n`;
      });
      result += '\n';
    }

    if (Object.keys(devDeps).length > 0) {
      result += `Development Dependencies (${Object.keys(devDeps).length}):\n`;
      Object.entries(devDeps).forEach(([name, version]) => {
        result += `  - ${name}: ${version}\n`;
      });
      result += '\n';
    }

    if (Object.keys(peerDeps).length > 0) {
      result += `Peer Dependencies (${Object.keys(peerDeps).length}):\n`;
      Object.entries(peerDeps).forEach(([name, version]) => {
        result += `  - ${name}: ${version}\n`;
      });
    }

    if (
      Object.keys(deps).length === 0 &&
      Object.keys(devDeps).length === 0 &&
      Object.keys(peerDeps).length === 0
    ) {
      result += 'No dependencies found.';
    }

    return result;
  } catch (error) {
    logger.error('❌ Failed to check dependencies:', error);
    throw error;
  }
}

/**
 * Update package.json
 */
async function updatePackageJson(
  packagePath: string,
  updates: Partial<PackageJson>
): Promise<string> {
  try {
    const packageJson = await readPackageJson(packagePath);

    // Merge updates with existing package.json
    const updatedPackageJson = { ...packageJson, ...updates };

    // Special handling for nested objects like scripts, dependencies
    if (updates.scripts) {
      updatedPackageJson.scripts = { ...packageJson.scripts, ...updates.scripts };
    }
    if (updates.dependencies) {
      updatedPackageJson.dependencies = { ...packageJson.dependencies, ...updates.dependencies };
    }
    if (updates.devDependencies) {
      updatedPackageJson.devDependencies = {
        ...packageJson.devDependencies,
        ...updates.devDependencies,
      };
    }

    await writePackageJson(packagePath, updatedPackageJson);

    logger.info(`✅ Updated package.json at ${packagePath}`);
    return `Successfully updated package.json for ${updatedPackageJson.name}`;
  } catch (error) {
    logger.error('❌ Failed to update package.json:', error);
    throw error;
  }
}

export const packageManagerCapability: RegisteredCapability = {
  name: 'package_manager',
  supportedActions: [
    'install_package',
    'create_package',
    'run_script',
    'check_dependencies',
    'update_package_json',
  ],
  description: 'Manages npm packages and package.json files safely within project workspace',
  handler: async (params, _content) => {
    const { action } = params;

    try {
      switch (action) {
        case 'install_package': {
          const { package_name, working_dir = '.', dev = false } = params;
          if (!package_name) {
            throw new Error('package_name is required for install_package action');
          }
          return await installPackage(package_name, working_dir, dev);
        }

        case 'create_package': {
          const { package_path = '.', options = {} } = params;
          return await createPackage(package_path, options);
        }

        case 'run_script': {
          const { script_name, working_dir = '.' } = params;
          if (!script_name) {
            throw new Error('script_name is required for run_script action');
          }
          return await runScript(script_name, working_dir);
        }

        case 'check_dependencies': {
          const { working_dir = '.' } = params;
          return await checkDependencies(working_dir);
        }

        case 'update_package_json': {
          const { package_path = '.', updates } = params;
          if (!updates) {
            throw new Error('updates object is required for update_package_json action');
          }
          return await updatePackageJson(package_path, updates);
        }

        default:
          throw new Error(
            `Unknown package_manager action: ${action}\n\n` +
              `Available actions: install_package, create_package, run_script, check_dependencies, update_package_json\n\n` +
              `Examples:\n` +
              `• <capability name="package_manager" action="install_package" package_name="express" working_dir="." />\n` +
              `• <capability name="package_manager" action="run_script" script_name="build" working_dir="." />\n` +
              `• <capability name="package_manager" action="check_dependencies" working_dir="." />\n` +
              `• <capability name="package_manager" action="create_package" package_path="." />`
          );
      }
    } catch (error) {
      logger.error(`❌ Package manager capability failed for action ${action}:`, error);
      throw error;
    }
  },
};
