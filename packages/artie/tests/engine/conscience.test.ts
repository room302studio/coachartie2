import { describe, it, expect, beforeEach } from 'vitest';

// Skip if OPENROUTER_API_KEY not set (conscience imports openrouter which requires it)
const hasApiKey = !!process.env.OPENROUTER_API_KEY;

describe.skipIf(!hasApiKey)('Conscience Safety Layer', () => {
  // Dynamic import to avoid module-level throw
  let ConscienceLLM: typeof import('../src/services/monitoring/conscience').ConscienceLLM;
  let conscience: InstanceType<typeof ConscienceLLM>;

  beforeEach(async () => {
    const module = await import('../src/services/monitoring/conscience');
    ConscienceLLM = module.ConscienceLLM;
    conscience = new ConscienceLLM();
  });

  describe('Immediate Failsafes (No LLM)', () => {
    it('blocks system file deletion (/etc/passwd)', async () => {
      const response = await conscience.review('delete /etc/passwd', {
        name: 'filesystem',
        action: 'delete',
        params: '/etc/passwd',
      });

      expect(response).toContain('BLOCKED');
      expect(response.toLowerCase()).toContain('system');
    });

    it('blocks /var path deletion', async () => {
      const response = await conscience.review('delete logs', {
        name: 'filesystem',
        action: 'delete',
        params: '/var/log/syslog',
      });

      expect(response).toContain('BLOCKED');
    });

    it('blocks /usr path deletion', async () => {
      const response = await conscience.review('delete binaries', {
        name: 'filesystem',
        action: 'delete',
        params: '/usr/bin/node',
      });

      expect(response).toContain('BLOCKED');
    });

    it('blocks rm -rf / shell command', async () => {
      const response = await conscience.review('run rm -rf /', {
        name: 'shell',
        action: 'execute',
        params: 'rm -rf /',
      });

      expect(response).toContain('BLOCKED');
      expect(response.toLowerCase()).toContain('destructive');
    });

    it('blocks rm -rf /* shell command', async () => {
      const response = await conscience.review('clean everything', {
        name: 'shell',
        action: 'execute',
        params: 'rm -rf /*',
      });

      expect(response).toContain('BLOCKED');
    });

    it('blocks dd if=/dev/zero command', async () => {
      const response = await conscience.review('wipe disk', {
        name: 'shell',
        action: 'execute',
        params: 'dd if=/dev/zero of=/dev/sda',
      });

      expect(response).toContain('BLOCKED');
    });

    it('blocks mkfs commands', async () => {
      const response = await conscience.review('format disk', {
        name: 'shell',
        action: 'execute',
        params: 'mkfs.ext4 /dev/sda1',
      });

      expect(response).toContain('BLOCKED');
    });
  });
});
