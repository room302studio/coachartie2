import { mkdir, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '@coachartie/shared';

const execAsync = promisify(exec);

interface MetroProcessResult {
  inputPath: string;
  outputPath?: string;
  stdout: string;
  stderr: string;
}

function getWorkDir(): string {
  return process.env.METRO_DOCTOR_WORKDIR || '/workspace/tmp/metro';
}

function resolveCommand(inputPath: string, outputPath: string): string {
  const template =
    process.env.METRO_DOCTOR_CMD || 'npx metro-savefile-doctor "{input}" "{output}"';
  return template.replaceAll('{input}', inputPath).replaceAll('{output}', outputPath);
}

async function downloadMetro(url: string): Promise<string> {
  const workDir = getWorkDir();
  await mkdir(workDir, { recursive: true });

  const filename = basename(new URL(url).pathname || `save-${Date.now()}.metro`);
  const safeName = filename || `save-${Date.now()}.metro`;
  const target = join(workDir, safeName);

  const maxMb = Number(process.env.METRO_DOCTOR_MAX_MB || 10);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const sizeMb = buf.length / (1024 * 1024);
  if (sizeMb > maxMb) {
    throw new Error(`File too large (${sizeMb.toFixed(2)} MB > ${maxMb} MB limit)`);
  }
  await writeFile(target, buf);
  return target;
}

export async function processMetroAttachment(url: string): Promise<MetroProcessResult> {
  const inputPath = await downloadMetro(url);
  const outputPath = inputPath.replace(/\.metro$/i, '.fixed.metro');

  const cmd = resolveCommand(inputPath, outputPath);
  logger.info(`🩺 Running metro doctor: ${cmd}`);

  const { stdout, stderr } = await execAsync(cmd, {
    cwd: getWorkDir(),
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30000,
  });

  // Determine output file (prefer explicit output if created)
  const hasOutput = existsSync(outputPath);
  const chosenOutput = hasOutput ? outputPath : inputPath;

  // Basic metadata to include
  const meta = await stat(chosenOutput);
  const metaLine = `Output: ${chosenOutput} (${(meta.size / (1024 * 1024)).toFixed(2)} MB)`;

  return {
    inputPath,
    outputPath: chosenOutput,
    stdout: `${metaLine}\n${stdout}`.trim(),
    stderr: stderr?.trim?.() || '',
  };
}
