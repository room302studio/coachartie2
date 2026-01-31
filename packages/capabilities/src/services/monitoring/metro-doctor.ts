/**
 * Metro Doctor Service for Coach Artie
 *
 * Uses the official metro-savefile-doctor repo for loading, analyzing,
 * and repairing .metro save files. The repair script is loaded from
 * the official repo, not hardcoded here.
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { createRequire } from 'module';
import { logger } from '@coachartie/shared';
import { analyzeMetroGeo, formatGeoInsights } from '../metro-geo-analysis.js';

// Import from official metro-savefile-doctor repo
import {
  readMetroSave,
  writeMetroSave,
  type MetroSaveData,
} from 'metro-savefile-doctor/metro-loader';
import { runJSScriptString, type SaveData } from 'metro-savefile-doctor/js-script-runner';

// Resolve path to the official repair script from metro-savefile-doctor
// Use createRequire to find the package location reliably
const require = createRequire(import.meta.url);
const metroLoaderPath = require.resolve('metro-savefile-doctor/metro-loader');
// metro-loader resolves to .../dist/metro-loader.js, go up twice to package root
const metroSavefileDoctorPath = dirname(dirname(metroLoaderPath));
const REPAIR_SCRIPT_PATH = join(metroSavefileDoctorPath, 'scripts', 'repair-save.js');

// Cache for the repair script
let cachedRepairScript: string | null = null;

async function getRepairScript(): Promise<string> {
  if (cachedRepairScript) return cachedRepairScript;

  try {
    cachedRepairScript = await readFile(REPAIR_SCRIPT_PATH, 'utf-8');
    logger.info(`🩺 Metro doctor: loaded repair script from ${REPAIR_SCRIPT_PATH}`);
    return cachedRepairScript;
  } catch (err) {
    logger.error(`🩺 Metro doctor: failed to load repair script from ${REPAIR_SCRIPT_PATH}`, err);
    throw new Error(`Failed to load repair script: ${(err as Error).message}`);
  }
}

interface MetroAnalysis {
  valid: boolean;
  name: string;
  cityCode: string;
  timestamp: number;
  stats: {
    stations: number;
    routes: number;
    trains: number;
    money: number;
    elapsedSeconds?: number;
  };
  autosaveCount: number;
  fileSizeBytes: number;
  errors: string[];
  warnings: string[];
  summary: string;
}

function getWorkDir(): string {
  return process.env.METRO_DOCTOR_WORKDIR || '/tmp/metro-doctor';
}

async function downloadMetro(url: string): Promise<Buffer> {
  const maxMb = Number(process.env.METRO_DOCTOR_MAX_MB || 50);

  logger.info(`🩺 Metro doctor: downloading from ${url}`);

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download: ${res.status} ${res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const sizeMb = buf.length / (1024 * 1024);

  if (sizeMb > maxMb) {
    throw new Error(`File too large (${sizeMb.toFixed(2)} MB > ${maxMb} MB limit)`);
  }

  logger.info(`🩺 Metro doctor: downloaded ${sizeMb.toFixed(2)} MB`);
  return buf;
}

function _formatPlaytime(seconds: number | undefined): string {
  if (!seconds) return 'Unknown';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatMoney(amount: number): string {
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount}`;
}

function buildAnalysisSummary(
  saveData: MetroSaveData,
  originalSize: number,
  warnings: string[],
  errors: string[]
): string {
  const stats = saveData.stats;
  const data = saveData.data || {};

  const actualStations = Array.isArray(data.stations) ? data.stations.length : stats.stations;
  const actualRoutes = Array.isArray(data.routes) ? data.routes.length : stats.routes;
  const actualTrains = Array.isArray(data.trains) ? data.trains.length : stats.trains;
  const money = formatMoney(stats.money || data.money || 0);
  const sizeMb = (originalSize / (1024 * 1024)).toFixed(1);

  const statusEmoji = errors.length === 0 ? '✅' : '❌';

  // Build detailed analysis
  let summary = `${statusEmoji} **${saveData.name}** (${saveData.cityCode || '?'})\n`;
  summary += `📊 **Stats:** ${actualStations} stations, ${actualRoutes} routes, ${actualTrains} trains | ${money} | ${sizeMb}MB\n`;

  // Add route analysis
  if (Array.isArray(data.routes) && data.routes.length > 0) {
    const routeDetails: string[] = [];
    const routesByType: Record<string, number> = {};

    for (const route of data.routes) {
      const routeType = route.bullet || 'Unknown';
      routesByType[routeType] = (routesByType[routeType] || 0) + 1;
    }

    for (const [type, count] of Object.entries(routesByType)) {
      routeDetails.push(`${type}: ${count}`);
    }

    if (routeDetails.length > 0) {
      summary += `🚇 **Routes:** ${routeDetails.join(', ')}\n`;
    }
  }

  // Add train analysis
  if (Array.isArray(data.trains) && data.trains.length > 0) {
    const currentTime = data.elapsedSeconds || 0;
    let movingTrains = 0;
    let stoppedTrains = 0;
    let stuckTrains = 0;

    for (const train of data.trains) {
      if (train.motion?.speed > 0) {
        movingTrains++;
      } else if (train.stuckDetection) {
        const timeSinceMove = currentTime - train.stuckDetection.lastMovementTime;
        if (timeSinceMove > 60) {
          stuckTrains++;
        } else {
          stoppedTrains++;
        }
      } else {
        stoppedTrains++;
      }
    }

    summary += `🚂 **Trains:** ${movingTrains} moving, ${stoppedTrains} stopped`;
    if (stuckTrains > 0) {
      summary += `, 🔧 ${stuckTrains} stuck (will fix)`;
    }
    summary += '\n';
  }

  // Add station analysis
  if (Array.isArray(data.stations) && data.stations.length > 0) {
    let overcrowdedStations = 0;
    let emptyStations = 0;

    for (const station of data.stations) {
      const passengers = station.passengers?.length || 0;
      if (passengers > 50) overcrowdedStations++;
      if (passengers === 0) emptyStations++;
    }

    if (overcrowdedStations > 0 || emptyStations > 5) {
      summary += `🏢 **Stations:** ${overcrowdedStations} overcrowded, ${emptyStations} empty\n`;
    }
  }

  // Geographic analysis with Turf.js
  try {
    const geoResult = analyzeMetroGeo(data);
    const geoInsights = formatGeoInsights(geoResult);
    if (geoInsights) {
      summary += `\n${geoInsights}\n`;
    }
  } catch (e) {
    // Skip geo analysis if it fails
    logger.warn('🩺 Metro doctor: geo analysis failed', e);
  }

  if (warnings.length > 0) {
    summary += `⚠️ **Issues found:** ${warnings.join('; ')}\n`;
  }

  if (errors.length > 0) {
    summary += `❌ **Errors:** ${errors.join('; ')}\n`;
  }

  return summary;
}

export async function processMetroAttachment(
  url: string,
  sender?: string
): Promise<{
  inputPath: string;
  outputPath?: string;
  stdout: string;
  stderr: string;
  buffer: Buffer;
  filename: string;
  analysis: MetroAnalysis;
}> {
  const workDir = getWorkDir();
  await mkdir(workDir, { recursive: true });

  // Slugify helper for safe filenames
  const slugify = (str: string) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 8);

  // Extract filename from URL
  let originalFilename = 'save.metro';
  try {
    const urlPath = new URL(url).pathname;
    originalFilename = basename(urlPath) || originalFilename;
  } catch {
    // Use default filename
  }

  // Prepend sender slug to filename
  const senderSlug = sender ? slugify(sender) : '';
  const filename = senderSlug ? `${senderSlug}_${originalFilename}` : originalFilename;

  // Download the file
  const originalBuffer = await downloadMetro(url);
  const originalSize = originalBuffer.length;

  // Save locally
  const inputPath = join(workDir, filename);
  await writeFile(inputPath, originalBuffer);

  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Use official metro-savefile-doctor to read the save
    const saveData = await readMetroSave(inputPath);

    logger.info(`🩺 Metro doctor: loaded save "${saveData.name}" from ${saveData.cityCode}`);

    // Check for potential issues in game data
    const data = saveData.data || {};

    // Track fixable issues (stuck trains) vs observations (everything else)
    let stuckTrainCount = 0;

    if (Array.isArray(data.trains)) {
      // Train structure: motion.speed, stuckDetection.lastMovementTime
      const currentTime = data.elapsedSeconds || 0;
      const stuckTrains = data.trains.filter((t: any) => {
        if (!t.motion || !t.stuckDetection) return false;
        const isStationary = t.motion.speed === 0;
        const timeSinceMove = currentTime - t.stuckDetection.lastMovementTime;
        return isStationary && timeSinceMove > 60; // Stuck for >60 seconds
      });
      stuckTrainCount = stuckTrains.length;
      if (stuckTrainCount > 0) {
        // This IS auto-fixable
        warnings.push(`🔧 ${stuckTrainCount} stuck trains (will nudge)`);
      }
    }

    if (Array.isArray(data.routes)) {
      // Routes use stNodes (station nodes), not stops
      // Trunk routes (name contains "Trunk") have 0 stNodes intentionally - don't warn
      const brokenRoutes = data.routes.filter((r: any) => {
        const hasStations = r.stNodes && r.stNodes.length >= 2;
        const isTrunkRoute = r.bullet && r.bullet.toLowerCase().includes('trunk');
        return !hasStations && !isTrunkRoute;
      });
      if (brokenRoutes.length > 0) {
        // NOT auto-fixable - just an observation
        warnings.push(`📋 ${brokenRoutes.length} routes have no stations (check in-game)`);
      }
    }

    if (data.money < 0) {
      // NOT auto-fixable
      warnings.push(`📋 Negative balance: ${formatMoney(data.money)} (you're in debt)`);
    }

    // Run repair script only if there are stuck trains to fix
    let resultBuffer = originalBuffer;
    let repairLog: string[] = [];

    if (stuckTrainCount > 0) {
      logger.info(`🩺 Metro doctor: running repair script to fix ${stuckTrainCount} stuck trains`);

      // Convert to SaveData format for script runner
      const scriptSaveData: SaveData = {
        id: saveData.gameSessionId,
        name: saveData.name,
        timestamp: saveData.timestamp,
        version: 1,
        cityCode: saveData.cityCode,
        data: saveData.data,
      };

      const repairScript = await getRepairScript();
      const scriptResult = runJSScriptString(repairScript, scriptSaveData);

      if (scriptResult.success) {
        repairLog = scriptResult.logs;
        logger.info(`🩺 Metro doctor: repair complete - ${repairLog.length} log entries`);

        // Update save data with repaired data
        saveData.data = scriptResult.save.data;

        // Write repaired file
        const repairedPath = join(workDir, `repaired_${filename}`);
        await writeMetroSave(repairedPath, saveData);

        // Read back the repaired buffer
        resultBuffer = await readFile(repairedPath);

        logger.info(
          `🩺 Metro doctor: repaired file size ${(resultBuffer.length / (1024 * 1024)).toFixed(2)} MB (was ${(originalSize / (1024 * 1024)).toFixed(2)} MB)`
        );
      } else {
        errors.push(...scriptResult.errors);
        logger.error(`🩺 Metro doctor: repair failed - ${scriptResult.errors.join(', ')}`);
      }
    }

    // Build summary
    const summary = buildAnalysisSummary(saveData, originalSize, warnings, errors);

    // Track if actual repairs were made (repair script ran and succeeded)
    // NOTE: Don't use buffer size comparison - it's unreliable since JSON can serialize to same size
    const actualRepairsMade = stuckTrainCount > 0 && resultBuffer !== originalBuffer;

    // Add repair info if repairs were made
    let finalSummary = summary;
    if (actualRepairsMade) {
      finalSummary += `\n🔧 **Fixed:** Nudged ${stuckTrainCount} stuck trains - download the repaired save below`;
    } else if (stuckTrainCount === 0 && warnings.length > 0) {
      finalSummary += `\n📋 _No auto-fixes needed. The issues above require manual changes in-game._`;
    }

    const analysis: MetroAnalysis = {
      valid: errors.length === 0,
      name: saveData.name,
      cityCode: saveData.cityCode,
      timestamp: saveData.timestamp,
      stats: saveData.stats,
      autosaveCount: saveData._autosaveIndex?.length || 0,
      fileSizeBytes: resultBuffer.length,
      errors,
      warnings,
      summary: finalSummary,
    };

    return {
      inputPath,
      outputPath: actualRepairsMade ? join(workDir, `repaired_${filename}`) : undefined,
      stdout: finalSummary,
      stderr: errors.join('\n'),
      buffer: resultBuffer, // Return repaired buffer if repairs were made
      filename: actualRepairsMade ? `repaired_${filename}` : filename,
      analysis,
    };
  } catch (err: any) {
    logger.error(`🩺 Metro doctor error: ${err.message}`);

    // Provide user-friendly error messages for common issues
    let friendlyError = err.message;
    let helpText = '';

    if (err.message.includes('Unexpected end of JSON') || err.message.includes('Unexpected token')) {
      friendlyError = 'Save file appears corrupted or incomplete';
      helpText = 'Try uploading a different save file or a manual save instead of an autosave.';
    } else if (err.message.includes('ENOENT')) {
      friendlyError = 'Could not read the file';
      helpText = 'Please try uploading again.';
    } else if (err.message.includes('too large')) {
      friendlyError = err.message;
      helpText = 'Try sharing a smaller save file.';
    }

    const errorSummary = helpText
      ? `❌ ${friendlyError}\n💡 ${helpText}`
      : `❌ ${friendlyError}`;

    errors.push(friendlyError);

    // Return original buffer on error
    return {
      inputPath,
      stdout: errorSummary,
      stderr: err.message,
      buffer: originalBuffer,
      filename,
      analysis: {
        valid: false,
        name: filename,
        cityCode: '',
        timestamp: 0,
        stats: { stations: 0, routes: 0, trains: 0, money: 0 },
        autosaveCount: 0,
        fileSizeBytes: originalSize,
        errors,
        warnings: [],
        summary: errorSummary,
      },
    };
  }
}
