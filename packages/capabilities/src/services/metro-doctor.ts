/**
 * Metro Doctor Service for Coach Artie
 *
 * Uses the official metro-savefile-doctor repo for loading, analyzing,
 * and repairing .metro save files.
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { logger } from '@coachartie/shared';

// Import from official metro-savefile-doctor repo
import { readMetroSave, writeMetroSave, type MetroSaveData } from 'metro-savefile-doctor/metro-loader';
import { runJSScriptString, type SaveData } from 'metro-savefile-doctor/js-script-runner';

// Repair script - fixes common save file issues
// NOTE: Routes use 'stNodes' (station nodes) - trunk routes have 0 stNodes intentionally
// We do NOT auto-remove routes - too risky. Only fix stuck trains.
// Train structure: motion.speed (not speed), stuckDetection.lastMovementTime (not state)
const REPAIR_SCRIPT = `
const fixes = [];
const currentTime = save.data.elapsedSeconds || 0;

// Fix: Nudge stuck trains (speed=0 for >60s)
if (save.data.trains && Array.isArray(save.data.trains)) {
    let stuckFixed = 0;
    save.data.trains.forEach(train => {
        if (!train.motion || !train.stuckDetection) return;

        const isStationary = train.motion.speed === 0;
        const timeSinceMove = currentTime - train.stuckDetection.lastMovementTime;
        const isStuck = isStationary && timeSinceMove > 60;

        if (isStuck) {
            // Give the train a small nudge to unstick it
            train.motion.speed = 0.1;
            train.stuckDetection.lastMovementTime = currentTime;
            stuckFixed++;
        }
    });
    if (stuckFixed > 0) {
        fixes.push('Nudged ' + stuckFixed + ' stuck trains');
        log('Nudged ' + stuckFixed + ' stuck trains (were stationary >60s)');
    }
}

// Summary
if (fixes.length === 0) {
    log('No issues found - save file is healthy!');
} else {
    log('Applied ' + fixes.length + ' fixes:');
    fixes.forEach(f => log('  - ' + f));
}
`;

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

function formatPlaytime(seconds: number | undefined): string {
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

  // Get actual counts from game data if available
  const actualStations = Array.isArray(data.stations) ? data.stations.length : stats.stations;
  const actualRoutes = Array.isArray(data.routes) ? data.routes.length : stats.routes;
  const actualTrains = Array.isArray(data.trains) ? data.trains.length : stats.trains;
  const elapsedSeconds = data.elapsedSeconds;

  const statusEmoji = errors.length === 0 ? '✅' : '⚠️';

  const lines = [
    `${statusEmoji} **${saveData.name}** (${saveData.cityCode || 'Unknown City'})`,
    '',
    `📊 **Stats:**`,
    `- Stations: ${actualStations}`,
    `- Routes: ${actualRoutes}`,
    `- Trains: ${actualTrains}`,
    `- Balance: ${formatMoney(stats.money || data.money || 0)}`,
    `- Playtime: ${formatPlaytime(elapsedSeconds)}`,
    '',
    `💾 **File Info:**`,
    `- Size: ${(originalSize / (1024 * 1024)).toFixed(2)} MB`,
    `- Last saved: ${new Date(saveData.timestamp).toLocaleString()}`,
  ];

  if (warnings.length > 0) {
    lines.push('', `⚠️ **Warnings:**`);
    warnings.forEach((w) => lines.push(`- ${w}`));
  }

  if (errors.length > 0) {
    lines.push('', `❌ **Errors:**`);
    errors.forEach((e) => lines.push(`- ${e}`));
  }

  return lines.join('\n');
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

    if (Array.isArray(data.trains)) {
      // Train structure: motion.speed, stuckDetection.lastMovementTime
      const currentTime = data.elapsedSeconds || 0;
      const stuckTrains = data.trains.filter((t: any) => {
        if (!t.motion || !t.stuckDetection) return false;
        const isStationary = t.motion.speed === 0;
        const timeSinceMove = currentTime - t.stuckDetection.lastMovementTime;
        return isStationary && timeSinceMove > 60; // Stuck for >60 seconds
      });
      if (stuckTrains.length > 0) {
        warnings.push(`${stuckTrains.length} trains may be stuck (stationary >60s)`);
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
        warnings.push(`${brokenRoutes.length} routes have no stations (may need attention)`);
      }
    }

    if (data.money < 0) {
      warnings.push(`Negative balance: ${formatMoney(data.money)}`);
    }

    // Run repair script if there are warnings (issues to fix)
    let resultBuffer = originalBuffer;
    let repairLog: string[] = [];

    if (warnings.length > 0) {
      logger.info(`🩺 Metro doctor: running repair script for ${warnings.length} potential issues`);

      // Convert to SaveData format for script runner
      const scriptSaveData: SaveData = {
        id: saveData.gameSessionId,
        name: saveData.name,
        timestamp: saveData.timestamp,
        version: 1,
        cityCode: saveData.cityCode,
        data: saveData.data,
      };

      const scriptResult = runJSScriptString(REPAIR_SCRIPT, scriptSaveData);

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

    // Add repair info to summary if repairs were made
    let finalSummary = summary;
    if (repairLog.length > 0 && resultBuffer.length !== originalSize) {
      const sizeDiff = originalSize - resultBuffer.length;
      const savedMb = (sizeDiff / (1024 * 1024)).toFixed(2);
      finalSummary += `\n\n🔧 **Repairs Applied:**\n`;
      repairLog.forEach((log) => (finalSummary += `- ${log}\n`));
      finalSummary += `\n📦 Repaired file: ${(resultBuffer.length / (1024 * 1024)).toFixed(2)} MB (saved ${savedMb} MB)`;
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
      outputPath: warnings.length > 0 ? join(workDir, `repaired_${filename}`) : undefined,
      stdout: finalSummary,
      stderr: errors.join('\n'),
      buffer: resultBuffer, // Return repaired buffer if repairs were made
      filename: warnings.length > 0 ? `repaired_${filename}` : filename,
      analysis,
    };
  } catch (err: any) {
    logger.error(`🩺 Metro doctor error: ${err.message}`);
    errors.push(err.message);

    // Return original buffer on error
    return {
      inputPath,
      stdout: `❌ Failed to process .metro file: ${err.message}`,
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
        summary: `❌ Failed to process .metro file: ${err.message}`,
      },
    };
  }
}
