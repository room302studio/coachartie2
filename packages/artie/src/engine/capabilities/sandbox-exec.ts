/**
 * Run a shell command inside the sandbox container (SANDBOX_CONTAINER_NAME, default
 * coachartie-sandbox), in /workspace. Shared by the context and diagnose capabilities; the
 * sandbox capability (dev/sandbox.ts) manages its own sessions and does not use this.
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function execInSandbox(
  command: string,
  limits: { timeoutMs: number; maxBufferBytes: number }
): Promise<{ stdout: string; stderr: string }> {
  const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';
  const dockerCommand = `docker exec -w /workspace ${containerName} /bin/bash -c ${JSON.stringify(command)}`;
  return await execAsync(dockerCommand, {
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxBufferBytes,
    env: process.env,
  });
}
