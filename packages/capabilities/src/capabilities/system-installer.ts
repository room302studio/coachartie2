import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * System package installation result
 */
interface InstallationResult {
  success: boolean;
  package: string;
  method: string;
  output?: string;
  error?: string;
}

/**
 * System Installer capability - installs system packages and dependencies
 */
class SystemInstaller {
  
  /**
   * Detect the package manager available on the system
   */
  private async detectPackageManager(): Promise<string | null> {
    const managers = [
      { name: 'brew', check: 'which brew' },
      { name: 'apt', check: 'which apt-get' },
      { name: 'yum', check: 'which yum' },
      { name: 'dnf', check: 'which dnf' },
      { name: 'pacman', check: 'which pacman' },
      { name: 'winget', check: 'which winget' },
      { name: 'choco', check: 'which choco' }
    ];

    for (const manager of managers) {
      try {
        await execAsync(manager.check);
        return manager.name;
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Get installation command for a package
   */
  private getInstallCommand(packageManager: string, packageName: string): string {
    const commands: Record<string, Record<string, string>> = {
      chrome: {
        brew: 'brew install --cask google-chrome',
        apt: 'wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list && apt-get update && apt-get install -y google-chrome-stable',
        yum: 'yum install -y google-chrome-stable',
        dnf: 'dnf install -y google-chrome-stable',
        winget: 'winget install Google.Chrome',
        choco: 'choco install googlechrome'
      },
      git: {
        brew: 'brew install git',
        apt: 'apt-get update && apt-get install -y git',
        yum: 'yum install -y git',
        dnf: 'dnf install -y git',
        pacman: 'pacman -S git',
        winget: 'winget install Git.Git',
        choco: 'choco install git'
      },
      docker: {
        brew: 'brew install --cask docker',
        apt: 'curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh',
        yum: 'yum install -y docker',
        dnf: 'dnf install -y docker',
        winget: 'winget install Docker.DockerDesktop',
        choco: 'choco install docker-desktop'
      },
      nodejs: {
        brew: 'brew install node',
        apt: 'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs',
        yum: 'yum install -y nodejs npm',
        dnf: 'dnf install -y nodejs npm',
        winget: 'winget install OpenJS.NodeJS',
        choco: 'choco install nodejs'
      }
    };

    return commands[packageName]?.[packageManager] || '';
  }

  /**
   * Check if a package is already installed
   */
  async checkPackage(packageName: string): Promise<boolean> {
    const checkCommands: Record<string, string> = {
      chrome: 'which google-chrome || which chromium || which chrome',
      git: 'which git',
      docker: 'which docker',
      nodejs: 'which node'
    };

    const command = checkCommands[packageName];
    if (!command) return false;

    try {
      await execAsync(command);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install a system package
   */
  async installPackage(packageName: string, force = false): Promise<InstallationResult> {
    logger.info(`Installing system package: ${packageName}`);

    // Check if already installed
    if (!force && await this.checkPackage(packageName)) {
      return {
        success: true,
        package: packageName,
        method: 'already_installed',
        output: `${packageName} is already installed`
      };
    }

    // Detect package manager
    const packageManager = await this.detectPackageManager();
    if (!packageManager) {
      return {
        success: false,
        package: packageName,
        method: 'none',
        error: 'No supported package manager found'
      };
    }

    // Get install command
    const installCommand = this.getInstallCommand(packageManager, packageName);
    if (!installCommand) {
      return {
        success: false,
        package: packageName,
        method: packageManager,
        error: `No installation method for ${packageName} using ${packageManager}`
      };
    }

    try {
      logger.info(`Installing ${packageName} using ${packageManager}: ${installCommand}`);
      const { stdout, stderr } = await execAsync(installCommand, { timeout: 300000 }); // 5 min timeout

      // Verify installation
      const isInstalled = await this.checkPackage(packageName);
      
      return {
        success: isInstalled,
        package: packageName,
        method: packageManager,
        output: stdout || stderr,
        error: isInstalled ? undefined : 'Installation completed but package not found'
      };

    } catch (error) {
      logger.error(`Failed to install ${packageName}:`, error);
      return {
        success: false,
        package: packageName,
        method: packageManager,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Install multiple packages
   */
  async installPackages(packages: string[]): Promise<InstallationResult[]> {
    const results: InstallationResult[] = [];
    
    for (const pkg of packages) {
      const result = await this.installPackage(pkg);
      results.push(result);
      
      // Stop on first failure for critical dependencies
      if (!result.success) {
        logger.warn(`Failed to install ${pkg}, continuing with remaining packages`);
      }
    }
    
    return results;
  }

  /**
   * Get system information
   */
  async getSystemInfo(): Promise<Record<string, any>> {
    const info: Record<string, any> = {
      platform: process.platform,
      arch: process.arch,
      packageManager: await this.detectPackageManager()
    };

    // Check available packages
    const packages = ['chrome', 'git', 'docker', 'nodejs'];
    for (const pkg of packages) {
      info[`has_${pkg}`] = await this.checkPackage(pkg);
    }

    return info;
  }
}

// Singleton instance
const systemInstaller = new SystemInstaller();

// Export service for other modules
export { systemInstaller };

/**
 * System Installer capability - installs system packages and dependencies
 * 
 * Supported actions:
 * - install: Install a system package (chrome, git, docker, nodejs)
 * - check: Check if a package is installed
 * - system_info: Get system and package manager information
 * - install_multiple: Install multiple packages
 * 
 * Parameters:
 * - package: Package name to install/check
 * - packages: Array of package names (for install_multiple)
 * - force: Force reinstallation even if already installed
 */
export const systemInstallerCapability: RegisteredCapability = {
  name: 'system_installer',
  supportedActions: ['install', 'check', 'system_info', 'install_multiple'],
  description: 'Installs system packages and dependencies (Chrome, Git, Docker, Node.js)',
  handler: async (params: any, content?: string) => {
    const { action } = params;

    try {
      switch (action) {
        case 'install': {
          const packageName = params.package || content;
          if (!packageName) {
            throw new Error('Package name is required');
          }
          
          const force = params.force || false;
          const result = await systemInstaller.installPackage(packageName, force);
          
          if (result.success) {
            return `Successfully installed ${result.package} using ${result.method}. ${result.output || ''}`;
          } else {
            throw new Error(`Failed to install ${result.package}: ${result.error}`);
          }
        }

        case 'check': {
          const packageName = params.package || content;
          if (!packageName) {
            throw new Error('Package name is required');
          }
          
          const isInstalled = await systemInstaller.checkPackage(packageName);
          return `${packageName} is ${isInstalled ? 'installed' : 'not installed'}`;
        }

        case 'system_info': {
          const info = await systemInstaller.getSystemInfo();
          return JSON.stringify(info, null, 2);
        }

        case 'install_multiple': {
          const packages = params.packages || (content ? JSON.parse(content) : []);
          if (!Array.isArray(packages) || packages.length === 0) {
            throw new Error('Array of package names is required');
          }
          
          const results = await systemInstaller.installPackages(packages);
          const successful = results.filter(r => r.success);
          const failed = results.filter(r => !r.success);
          
          let response = `Installation completed: ${successful.length} successful, ${failed.length} failed\n`;
          
          if (successful.length > 0) {
            response += `\nSuccessful: ${successful.map(r => r.package).join(', ')}`;
          }
          
          if (failed.length > 0) {
            response += `\nFailed: ${failed.map(r => `${r.package} (${r.error})`).join(', ')}`;
          }
          
          return response;
        }

        default:
          throw new Error(`Unknown system installer action: ${action}`);
      }
    } catch (error) {
      logger.error(`System installer capability failed for action ${action}:`, error);
      throw error;
    }
  }
};