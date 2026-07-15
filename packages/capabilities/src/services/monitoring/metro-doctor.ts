/**
 * Metro Doctor Service for Coach Artie
 *
 * Orchestrates analysis/repair of .metro save files. The heavy lifting
 * (decompress + parse + repair, which can hold hundreds of MB in memory and
 * block the event loop) is delegated to a short-lived CHILD PROCESS
 * (metro-analyzer-child.js). This keeps a malformed or huge save from OOM-ing
 * or freezing the main capabilities process, which serves every message.
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { logger } from '@coachartie/shared';

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

/** Shape written by metro-analyzer-child.ts to its output JSON file. */
interface ChildAnalysisResult {
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

function getWorkDir(): string {
  return process.env.METRO_DOCTOR_WORKDIR || '/tmp/metro-doctor';
}

async function downloadMetro(url: string): Promise<Buffer> {
  const maxMb = Number(process.env.METRO_DOCTOR_MAX_MB || 50);
  const timeoutMs = Number(process.env.METRO_DOCTOR_DOWNLOAD_TIMEOUT_MS || 30_000);

  logger.info(`🩺 Metro doctor: downloading from ${url}`);

  // Bound the download so a slow/hung host can't wedge the request forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Download timed out after ${(timeoutMs / 1000).toFixed(0)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

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

// Serialize analyzer children so a burst of large uploads can't spawn several
// multi-GB processes at once and trip the kernel OOM-killer on a shared box.
// Only one heavy child runs at a time; the rest queue behind it.
let analyzerChain: Promise<unknown> = Promise.resolve();

function runAnalyzerChild(
  inputPath: string,
  outputJsonPath: string
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const run = analyzerChain
    .catch(() => {})
    .then(() => spawnAnalyzerChild(inputPath, outputJsonPath));
  // Keep the chain alive regardless of individual success/failure.
  analyzerChain = run.catch(() => {});
  return run;
}

/**
 * Run the heavy parse/analyze/repair in an isolated child process with a
 * memory cap and a hard timeout. The child never shares the main process heap,
 * so an OOM or infinite loop kills only the child — the bot stays up.
 *
 * The 512MB default was far too small for real saves (a 28MB Tokyo save needs
 * ~2GB once decompressed + JSON-parsed + cloned by the repair pass), so it
 * OOM'd on every large file. Default is now 2GB, still bounded and overridable.
 */
function spawnAnalyzerChild(
  inputPath: string,
  outputJsonPath: string
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const childPath = join(dirname(fileURLToPath(import.meta.url)), 'metro-analyzer-child.js');
  const maxOldSpaceMb = Number(process.env.METRO_DOCTOR_MAX_OLD_SPACE_MB || 2048);
  const timeoutMs = Number(process.env.METRO_DOCTOR_TIMEOUT_MS || 90_000);

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${maxOldSpaceMb}`, childPath, inputPath, outputJsonPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn(`🩺 Metro doctor: analyzer child timed out after ${timeoutMs}ms — killing`);
      child.kill('SIGKILL');
    }, timeoutMs);

    // Cap captured output so a chatty/looping child can't balloon memory here.
    child.stdout?.on('data', (d) => {
      stdout = (stdout + d.toString()).slice(-100_000);
    });
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-100_000);
    });
    child.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
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

  try {
    // Delegate all heavy work to the isolated child process.
    const outputJsonPath = join(workDir, `analysis_${filename}.json`);
    const { code, stderr, timedOut } = await runAnalyzerChild(inputPath, outputJsonPath);

    if (timedOut) {
      throw new Error('Analysis timed out — the save is too large or complex to process');
    }
    if (code !== 0) {
      // Detect an out-of-memory kill (SIGABRT / heap limit) and report it plainly
      // instead of dumping a native V8 stack trace at the user.
      if (
        code === 134 ||
        /heap out of memory|Allocation failed|Reached heap limit/i.test(stderr)
      ) {
        throw new Error(
          'Save too large to analyze — it exceeded the memory budget. ' +
            '(Raise METRO_DOCTOR_MAX_OLD_SPACE_MB if the server has headroom.)'
        );
      }
      // Otherwise surface the child's own human-readable error line.
      const lastLine = stderr.trim().split('\n').filter(Boolean).pop();
      throw new Error(lastLine || `Analyzer exited with code ${code}`);
    }

    let child: ChildAnalysisResult;
    try {
      child = JSON.parse(await readFile(outputJsonPath, 'utf-8')) as ChildAnalysisResult;
    } catch {
      throw new Error('Analyzer produced no readable result');
    }

    logger.info(`🩺 Metro doctor: analyzed "${child.name}" (${child.cityCode || '?'}) via child`);

    // Read the repaired buffer if the child produced one; fall back to original.
    let resultBuffer = originalBuffer;
    let outputPath: string | undefined;
    let outFilename = filename;
    if (child.repairedFilePath) {
      try {
        resultBuffer = await readFile(child.repairedFilePath);
        outputPath = child.repairedFilePath;
        outFilename = `repaired_${filename}`;
      } catch (e) {
        logger.warn(`🩺 Metro doctor: repaired file missing, using original: ${String(e)}`);
      }
    }

    const analysis: MetroAnalysis = {
      valid: child.errors.length === 0,
      name: child.name,
      cityCode: child.cityCode,
      timestamp: child.timestamp,
      stats: child.stats,
      autosaveCount: child.autosaveCount,
      fileSizeBytes: resultBuffer.length,
      errors: child.errors,
      warnings: child.warnings,
      summary: child.summary,
    };

    return {
      inputPath,
      outputPath,
      stdout: child.summary,
      stderr: child.errors.join('\n'),
      buffer: resultBuffer,
      filename: outFilename,
      analysis,
    };
  } catch (err: any) {
    logger.error(`🩺 Metro doctor error: ${err.message}`);

    // Provide user-friendly error messages for common issues
    let friendlyError = err.message;
    let helpText = '';

    if (
      err.message.includes('Unexpected end of JSON') ||
      err.message.includes('Unexpected token')
    ) {
      friendlyError = 'Save file appears corrupted or incomplete';
      helpText = 'Try uploading a different save file or a manual save instead of an autosave.';
    } else if (err.message.includes('ENOENT')) {
      friendlyError = 'Could not read the file';
      helpText = 'Please try uploading again.';
    } else if (err.message.includes('too large') || err.message.includes('timed out')) {
      friendlyError = err.message;
      helpText = 'Try sharing a smaller save file.';
    }

    const errorSummary = helpText ? `❌ ${friendlyError}\n💡 ${helpText}` : `❌ ${friendlyError}`;

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
