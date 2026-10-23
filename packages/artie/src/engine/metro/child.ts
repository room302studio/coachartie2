/**
 * Metro Analyzer Child Process
 *
 * Short-lived worker that does ALL heavy .metro save parsing/analysis so the
 * main capabilities process never holds the decompressed save in memory.
 * Launched by metro-doctor.ts via:
 *   node --max-old-space-size=512 metro-analyzer-child.js <inputPath> <outputJsonPath>
 *
 * Writes a compact JSON result to <outputJsonPath> and exits 0 on success.
 * On failure, prints the error message to stderr and exits nonzero.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { createRequire } from 'module';
import { analyzeMetroGeo, formatGeoInsights } from '../metro-geo-analysis.js';

// Import from official metro-savefile-doctor repo
import {
  readMetroSave,
  writeMetroSave,
  type MetroSaveData,
} from 'metro-savefile-doctor/metro-loader';
import { runJSScriptString, type SaveData } from 'metro-savefile-doctor/js-script-runner';

// Resolve path to the official repair script from metro-savefile-doctor
const require = createRequire(import.meta.url);
const metroLoaderPath = require.resolve('metro-savefile-doctor/metro-loader');
const metroSavefileDoctorPath = dirname(dirname(metroLoaderPath));
const REPAIR_SCRIPT_PATH = join(metroSavefileDoctorPath, 'scripts', 'repair-save.js');

export interface ChildAnalysisResult {
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
  errors: string[];
  warnings: string[];
  summary: string;
  stuckTrainCount: number;
  repairedFilePath: string | null;
  repairedFileSizeBytes: number | null;
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
    console.error(`metro-analyzer-child: geo analysis failed: ${(e as Error).message}`);
  }

  if (warnings.length > 0) {
    summary += `⚠️ **Issues found:** ${warnings.join('; ')}\n`;
  }

  if (errors.length > 0) {
    summary += `❌ **Errors:** ${errors.join('; ')}\n`;
  }

  return summary;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputJsonPath = process.argv[3];

  if (!inputPath || !outputJsonPath) {
    throw new Error('Usage: metro-analyzer-child.js <inputPath> <outputJsonPath>');
  }

  const originalSize = (await stat(inputPath)).size;

  const errors: string[] = [];
  const warnings: string[] = [];

  // Heavy: decompress + parse the entire save
  const saveData = await readMetroSave(inputPath);
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
  let repairedFilePath: string | null = null;
  let repairedFileSizeBytes: number | null = null;

  if (stuckTrainCount > 0) {
    console.error(`metro-analyzer-child: running repair script for ${stuckTrainCount} stuck trains`);

    // Convert to SaveData format for script runner
    const scriptSaveData: SaveData = {
      id: saveData.gameSessionId,
      name: saveData.name,
      timestamp: saveData.timestamp,
      version: 1,
      cityCode: saveData.cityCode,
      data: saveData.data,
    };

    const repairScript = await readFile(REPAIR_SCRIPT_PATH, 'utf-8');
    const scriptResult = runJSScriptString(repairScript, scriptSaveData);

    if (scriptResult.success) {
      // Update save data with repaired data
      saveData.data = scriptResult.save.data;

      // Write repaired file next to the input file
      repairedFilePath = join(dirname(inputPath), `repaired_${basename(inputPath)}`);
      await writeMetroSave(repairedFilePath, saveData);
      repairedFileSizeBytes = (await stat(repairedFilePath)).size;
    } else {
      errors.push(...scriptResult.errors);
      console.error(`metro-analyzer-child: repair failed - ${scriptResult.errors.join(', ')}`);
    }
  }

  // Build summary
  const summary = buildAnalysisSummary(saveData, originalSize, warnings, errors);

  let finalSummary = summary;
  if (repairedFilePath) {
    finalSummary += `\n🔧 **Fixed:** Nudged ${stuckTrainCount} stuck trains - download the repaired save below`;
  } else if (stuckTrainCount === 0 && warnings.length > 0) {
    finalSummary += `\n📋 _No auto-fixes needed. The issues above require manual changes in-game._`;
  }

  const result: ChildAnalysisResult = {
    name: saveData.name,
    cityCode: saveData.cityCode,
    timestamp: saveData.timestamp,
    stats: saveData.stats,
    autosaveCount: saveData._autosaveIndex?.length || 0,
    errors,
    warnings,
    summary: finalSummary,
    stuckTrainCount,
    repairedFilePath,
    repairedFileSizeBytes,
  };

  await writeFile(outputJsonPath, JSON.stringify(result));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
