#!/usr/bin/env tsx
/**
 * Local Chat REPL - Talk to Coach Artie without Discord
 *
 * Connects to the capabilities service HTTP API.
 * Requires: Redis + capabilities service running.
 *
 * Usage:
 *   pnpm chat                        # interactive REPL
 *   pnpm chat "what can you do?"     # one-shot message
 *
 * Start the backend first:
 *   pnpm dev:capabilities
 */

// Ensure chalk (used by marked-terminal) outputs ANSI colors
if (!process.env.FORCE_COLOR && process.stdout.isTTY) {
  process.env.FORCE_COLOR = '1';
}

import * as readline from 'readline';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

const API_BASE = process.env.ARTIE_API ?? 'http://127.0.0.1:47324';
const USER_ID = process.env.ARTIE_USER ?? `local-${process.env.USER ?? 'dev'}`;
const TIMEOUT_MS = 120_000;

// -- colors --
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function artieLabel() {
  return `${c.bold}${c.cyan}artie${c.reset}`;
}

// -- markdown renderer --
marked.setOptions({
  renderer: new TerminalRenderer({
    width: Math.min(process.stdout.columns || 80, 100),
    reflowText: true,
    showSectionPrefix: false,
  }),
});

/** Split response into prose and tool calls, render each */
function renderResponse(text: string): string {
  // Extract tool call tags (self-closing and with content)
  const toolPattern = /<(recall|websearch|search|google|fetch|browse|read|readfile|write|writefile|remember|store|calc|math|wolfram|capability|wants_loop|see|ocr|email|github)[^>]*(?:\/>|>[\s\S]*?<\/\1>)/gi;
  const tools: string[] = [];
  const prose = text.replace(toolPattern, (match) => {
    tools.push(match.trim());
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  let output = '';

  // Render the prose as markdown
  if (prose) {
    try {
      output = (marked.parse(prose) as string).trimEnd();
    } catch {
      output = prose;
    }
  }

  // Render tool calls in a right-aligned dim column
  if (tools.length > 0) {
    const cols = process.stdout.columns || 80;
    const toolLines = tools.map((t) => {
      // Truncate long tool calls
      const short = t.length > cols - 4 ? t.slice(0, cols - 7) + '...' : t;
      const pad = Math.max(0, cols - short.length - 1);
      return `${' '.repeat(pad)}${c.dim}${short}${c.reset}`;
    });
    output += '\n' + toolLines.join('\n');
  }

  return output;
}

// -- health check --
async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// -- send message with SSE streaming --
async function sendMessage(text: string): Promise<string> {
  // 1. Submit the message (async mode — we'll stream via SSE)
  const submitRes = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: text,
      userId: USER_ID,
      source: 'api',
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`Submit failed (${submitRes.status}): ${body}`);
  }

  const { messageId, status, response } = (await submitRes.json()) as {
    messageId: string;
    status: string;
    response?: string;
  };

  // If already complete (unlikely without ?wait), return immediately
  if (status === 'completed' && response) return response;

  // 2. Stream via SSE
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Response timeout'));
    }, TIMEOUT_MS);

    let lastPartial = '';

    (async () => {
      try {
        const sseRes = await fetch(`${API_BASE}/chat/${messageId}/stream`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!sseRes.ok || !sseRes.body) {
          // Fallback to polling
          clearTimeout(timeout);
          resolve(await pollForResult(messageId));
          return;
        }

        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep incomplete line

          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const data = line.slice(6);
              try {
                const parsed = JSON.parse(data);

                if (eventType === 'progress' && parsed.partial) {
                  // Track progress but don't print raw text (we render markdown at the end)
                  lastPartial = parsed.partial;
                } else if (eventType === 'complete') {
                  clearTimeout(timeout);
                  resolve(parsed.response ?? parsed.error ?? 'No response');
                  return;
                } else if (eventType === 'error' || eventType === 'timeout') {
                  clearTimeout(timeout);
                  reject(new Error(parsed.error ?? 'Stream error'));
                  return;
                }
              } catch {
                // ignore parse errors in SSE
              }
            }
          }
        }

        // Stream ended without complete event — fall back to poll
        clearTimeout(timeout);
        resolve(await pollForResult(messageId));
      } catch (err) {
        clearTimeout(timeout);
        // SSE failed — fall back to polling
        try {
          resolve(await pollForResult(messageId));
        } catch (pollErr) {
          reject(pollErr);
        }
      }
    })();
  });
}

// -- polling fallback --
async function pollForResult(messageId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/chat/${messageId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { status: string; response?: string; error?: string };
      if (data.status === 'completed') return data.response ?? 'No response';
      if (data.status === 'failed') throw new Error(data.error ?? 'Processing failed');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Polling timeout');
}

// -- one-shot mode --
async function oneShot(text: string) {
  const healthy = await checkHealth();
  if (!healthy) {
    console.error(`${c.red}Cannot reach capabilities service at ${API_BASE}${c.reset}`);
    console.error(`${c.dim}Start it with: pnpm dev:capabilities${c.reset}`);
    process.exit(1);
  }

  process.stdout.write(`${c.dim}thinking...${c.reset}`);
  try {
    const response = await sendMessage(text);
    process.stdout.write(`\r\x1b[K`); // clear "thinking..."
    console.log(`${artieLabel()}\n${renderResponse(response)}`);
  } catch (err) {
    process.stdout.write(`\r\x1b[K`);
    console.error(`${c.red}Error: ${err instanceof Error ? err.message : err}${c.reset}`);
    process.exit(1);
  }
}

// -- interactive REPL --
async function repl() {
  console.log(`${c.bold}${c.cyan}Coach Artie — Local Chat${c.reset}`);
  console.log(`${c.dim}API: ${API_BASE}  User: ${USER_ID}${c.reset}`);
  console.log(`${c.dim}Type /quit to exit, /caps to list capabilities${c.reset}\n`);

  // Health check
  const healthy = await checkHealth();
  if (!healthy) {
    console.error(`${c.red}Cannot reach capabilities service at ${API_BASE}${c.reset}`);
    console.error(`\n${c.yellow}To start the backend:${c.reset}`);
    console.error(`  1. Make sure Redis is running: ${c.dim}docker ps | grep redis${c.reset}`);
    console.error(`  2. Build the project: ${c.dim}pnpm build${c.reset}`);
    console.error(`  3. Start capabilities: ${c.dim}pnpm dev:capabilities${c.reset}`);
    console.error(`\n${c.dim}Or start everything: pnpm dev${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.green}Connected to Artie${c.reset}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.bold}you${c.reset} `,
    historySize: 200,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    // Slash commands
    if (text === '/quit' || text === '/exit' || text === '/q') {
      console.log(`${c.dim}bye${c.reset}`);
      rl.close();
      process.exit(0);
    }

    if (text === '/caps' || text === '/capabilities') {
      try {
        const res = await fetch(`${API_BASE}/capabilities`);
        const data = (await res.json()) as { capabilities?: Array<{ name: string; emoji?: string; description?: string }> };
        if (data.capabilities) {
          console.log(`\n${c.bold}Capabilities:${c.reset}`);
          for (const cap of data.capabilities) {
            console.log(`  ${cap.emoji ?? '  '} ${c.cyan}${cap.name}${c.reset} ${c.dim}${cap.description ?? ''}${c.reset}`);
          }
          console.log();
        }
      } catch (err) {
        console.error(`${c.red}Failed to list capabilities${c.reset}`);
      }
      rl.prompt();
      return;
    }

    if (text === '/health') {
      try {
        const res = await fetch(`${API_BASE}/health`);
        const data = await res.json();
        console.log(`\n${c.green}Health:${c.reset}`, JSON.stringify(data, null, 2), '\n');
      } catch {
        console.error(`${c.red}Health check failed${c.reset}`);
      }
      rl.prompt();
      return;
    }

    if (text === '/help') {
      console.log(`
${c.bold}Commands:${c.reset}
  ${c.yellow}/quit${c.reset}     Exit
  ${c.yellow}/caps${c.reset}     List capabilities
  ${c.yellow}/health${c.reset}   Check service health
  ${c.yellow}/help${c.reset}     This message
`);
      rl.prompt();
      return;
    }

    // Send message to Artie
    process.stdout.write(`${c.dim}...${c.reset}\r`);
    try {
      const response = await sendMessage(text);
      process.stdout.write(`\r\x1b[K`); // clear spinner line
      console.log(`\n${artieLabel()}\n${renderResponse(response)}\n`);
    } catch (err) {
      process.stdout.write(`\r\x1b[K`);
      console.error(`${c.red}Error: ${err instanceof Error ? err.message : err}${c.reset}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// -- main --
const args = process.argv.slice(2);
if (args.length > 0 && !args[0].startsWith('-')) {
  oneShot(args.join(' '));
} else {
  repl();
}
