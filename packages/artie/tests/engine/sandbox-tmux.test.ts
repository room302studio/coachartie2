import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wave 7 / ledger #10: tmux commands go to docker as an argv array (execFile, no shell),
// and send types the command with `send-keys -l`, unescaped.
const { execFileMock, execMock } = vi.hoisted(() => {
  const reply = (optsOrCb: unknown, maybeCb?: unknown) => {
    let cb: (
      err: Error | null,
      out?: { stdout: string; stderr: string }
    ) => void;
    if (typeof optsOrCb === 'function') {
      cb = optsOrCb as (
        err: Error | null,
        out?: { stdout: string; stderr: string }
      ) => void;
    } else {
      cb = maybeCb as (
        err: Error | null,
        out?: { stdout: string; stderr: string }
      ) => void;
    }
    cb(null, { stdout: '1\n', stderr: '' });
    return {} as unknown;
  };
  return {
    execFileMock: vi.fn((_file: string, _args: string[], o: unknown, cb?: unknown) => reply(o, cb)),
    execMock: vi.fn((_cmd: string, o: unknown, cb?: unknown) => reply(o, cb)),
  };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: execMock,
    execFile: execFileMock,
    default: { ...actual, exec: execMock, execFile: execFileMock },
  };
});

import { sandboxCapability } from '../../src/engine/tools/dev/sandbox.js';

const argvs = () => execFileMock.mock.calls.map((c) => ({ file: c[0], args: c[1] as string[] }));

describe('sandbox tmux uses argv + send-keys -l', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    execMock.mockClear();
  });

  it('send passes the raw command as one literal argv element', async () => {
    const command = 'echo "$(whoami)" `id` \\ done';
    await sandboxCapability.handler({ action: 'send', session: 's1', command }, undefined);

    const calls = argvs();
    expect(calls.every((c) => c.file === 'docker')).toBe(true);
    const send = calls.find((c) => c.args.includes('send-keys') && c.args.includes('-l'));
    expect(send).toBeDefined();
    expect(send!.args.slice(-4)).toEqual(['s1:0', '-l', '--', command]);
    // Enter is its own, non-literal keypress
    const enter = calls.find((c) => c.args.includes('send-keys') && !c.args.includes('-l'));
    expect(enter!.args.slice(-1)).toEqual(['Enter']);
    // nothing went through a shell
    expect(execMock).not.toHaveBeenCalled();
  });

  it('docker gets env var names, never values, and no bash -c', async () => {
    await sandboxCapability.handler({ action: 'send', session: 's1', command: 'ls' }, undefined);
    for (const { args } of argvs()) {
      expect(args.slice(0, 5)).toEqual(['exec', '-e', 'GITHUB_TOKEN', '-e', 'OPENAI_API_KEY']);
      expect(args).not.toContain('-c');
      expect(args.some((a) => a.includes('='))).toBe(false);
    }
  });

  it('split passes the command as one argv element', async () => {
    const command = 'tail -f "a b.log"';
    await sandboxCapability.handler({ action: 'split', session: 's2', command }, undefined);
    const split = argvs().find((c) => c.args.includes('split-window'));
    expect(split!.args[split!.args.length - 1]).toBe(command);
  });
});
