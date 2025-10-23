import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * ASCII Art Generator MCP Server 🎨
 * Generate ASCII art from text, create banners, draw shapes, and make fun text-based designs
 *
 * This server provides tools for creating various types of ASCII art without any API dependencies
 */

class AsciiArtGeneratorMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'ascii-art-generator-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'text_banner',
            description: 'Convert text into ASCII art banner using block letters',
            inputSchema: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: 'Text to convert to ASCII banner',
                },
                style: {
                  type: 'string',
                  enum: ['block', 'bubble', 'thin', 'thick'],
                  description: 'ASCII banner style',
                  default: 'block',
                },
              },
              required: ['text'],
            },
          },
          {
            name: 'draw_box',
            description: 'Draw ASCII boxes and frames with custom dimensions',
            inputSchema: {
              type: 'object',
              properties: {
                width: {
                  type: 'number',
                  description: 'Width of the box',
                  minimum: 3,
                  maximum: 100,
                },
                height: {
                  type: 'number',
                  description: 'Height of the box',
                  minimum: 3,
                  maximum: 50,
                },
                style: {
                  type: 'string',
                  enum: ['single', 'double', 'thick', 'rounded', 'dashed'],
                  description: 'Box border style',
                  default: 'single',
                },
                fill: {
                  type: 'string',
                  description: 'Text to put inside the box (optional)',
                  maxLength: 200,
                },
              },
              required: ['width', 'height'],
            },
          },
          {
            name: 'ascii_shapes',
            description: 'Draw ASCII geometric shapes like triangles, diamonds, circles',
            inputSchema: {
              type: 'object',
              properties: {
                shape: {
                  type: 'string',
                  enum: ['triangle', 'diamond', 'circle', 'star', 'heart', 'arrow'],
                  description: 'Type of shape to draw',
                },
                size: {
                  type: 'number',
                  description: 'Size of the shape',
                  minimum: 3,
                  maximum: 25,
                  default: 5,
                },
                filled: {
                  type: 'boolean',
                  description: 'Whether the shape should be filled or outline only',
                  default: false,
                },
              },
              required: ['shape'],
            },
          },
          {
            name: 'text_effects',
            description: 'Apply special text effects like mirror, reverse, upside-down',
            inputSchema: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: 'Text to apply effects to',
                  maxLength: 100,
                },
                effect: {
                  type: 'string',
                  enum: ['mirror', 'reverse', 'upside_down', 'wave', 'stairs', 'zigzag'],
                  description: 'Effect to apply to the text',
                },
              },
              required: ['text', 'effect'],
            },
          },
          {
            name: 'random_art',
            description: 'Generate random ASCII art patterns and designs',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['pattern', 'mandala', 'maze', 'abstract', 'landscape'],
                  description: 'Type of random art to generate',
                  default: 'pattern',
                },
                width: {
                  type: 'number',
                  description: 'Width of the generated art',
                  minimum: 10,
                  maximum: 80,
                  default: 40,
                },
                height: {
                  type: 'number',
                  description: 'Height of the generated art',
                  minimum: 5,
                  maximum: 30,
                  default: 15,
                },
              },
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'text_banner':
            return await this.handleTextBanner(args);
          case 'draw_box':
            return await this.handleDrawBox(args);
          case 'ascii_shapes':
            return await this.handleAsciiShapes(args);
          case 'text_effects':
            return await this.handleTextEffects(args);
          case 'random_art':
            return await this.handleRandomArt(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private async handleTextBanner(args: any): Promise<any> {
    const text = (args.text || '').toUpperCase();
    const style = args.style || 'block';

    if (!text) {
      throw new McpError(ErrorCode.InvalidParams, 'Text is required for banner creation');
    }

    let result = '';

    if (style === 'block') {
      // Simple block letter implementation
      const blockLetters: Record<string, string[]> = {
        A: ['█████', '█   █', '█████', '█   █', '█   █'],
        B: ['████ ', '█   █', '████ ', '█   █', '████ '],
        C: ['█████', '█    ', '█    ', '█    ', '█████'],
        D: ['████ ', '█   █', '█   █', '█   █', '████ '],
        E: ['█████', '█    ', '███  ', '█    ', '█████'],
        F: ['█████', '█    ', '███  ', '█    ', '█    '],
        G: ['█████', '█    ', '█ ███', '█   █', '█████'],
        H: ['█   █', '█   █', '█████', '█   █', '█   █'],
        I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
        J: ['█████', '    █', '    █', '█   █', '█████'],
        K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
        L: ['█    ', '█    ', '█    ', '█    ', '█████'],
        M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
        N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
        O: ['█████', '█   █', '█   █', '█   █', '█████'],
        P: ['████ ', '█   █', '████ ', '█    ', '█    '],
        Q: ['█████', '█   █', '█ █ █', '█  ██', '█████'],
        R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
        S: ['█████', '█    ', '█████', '    █', '█████'],
        T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
        U: ['█   █', '█   █', '█   █', '█   █', '█████'],
        V: ['█   █', '█   █', '█   █', ' █ █ ', '  █  '],
        W: ['█   █', '█   █', '█ █ █', '██ ██', '█   █'],
        X: ['█   █', ' █ █ ', '  █  ', ' █ █ ', '█   █'],
        Y: ['█   █', ' █ █ ', '  █  ', '  █  ', '  █  '],
        Z: ['█████', '   █ ', '  █  ', ' █   ', '█████'],
        ' ': ['     ', '     ', '     ', '     ', '     '],
        '!': ['  █  ', '  █  ', '  █  ', '     ', '  █  '],
        '?': ['█████', '    █', '  ██ ', '     ', '  █  '],
      };

      const lines = ['', '', '', '', ''];
      for (const char of text) {
        const pattern = blockLetters[char] || blockLetters[' '];
        for (let i = 0; i < 5; i++) {
          lines[i] += pattern[i] + ' ';
        }
      }
      result = lines.join('\n');
    } else if (style === 'bubble') {
      // Bubble letter style
      result = text
        .split('')
        .map((char: string) => {
          if (char === ' ') return '   ';
          return `(${char})`;
        })
        .join(' ');
    } else if (style === 'thin') {
      // Thin line style
      result = text.split('').join(' ');
    } else {
      // Default thick style
      result = text
        .split('')
        .map((char: string) => `█${char}█`)
        .join(' ');
    }

    return {
      content: [
        {
          type: 'text',
          text: `🎨 ASCII Banner (${style} style):\n\n${result}`,
        },
      ],
    };
  }

  private async handleDrawBox(args: any): Promise<any> {
    const width = Math.max(3, Math.min(100, args.width || 10));
    const height = Math.max(3, Math.min(50, args.height || 5));
    const style = args.style || 'single';
    const fill = args.fill || '';

    const styles: Record<
      string,
      { tl: string; tr: string; bl: string; br: string; h: string; v: string }
    > = {
      single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
      double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
      thick: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
      rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
      dashed: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
    };

    const s = styles[style];
    let result = '';

    // Top border
    result += s.tl + s.h.repeat(width - 2) + s.tr + '\n';

    // Middle rows
    for (let i = 1; i < height - 1; i++) {
      let row = s.v;

      if (fill && i === Math.floor(height / 2)) {
        // Center the text
        const padding = Math.max(0, width - 2 - fill.length);
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        row += ' '.repeat(leftPad) + fill.substring(0, width - 2) + ' '.repeat(rightPad);
      } else {
        row += ' '.repeat(width - 2);
      }

      row += s.v + '\n';
      result += row;
    }

    // Bottom border
    result += s.bl + s.h.repeat(width - 2) + s.br;

    return {
      content: [
        {
          type: 'text',
          text: `📦 ASCII Box (${width}×${height}, ${style} style):\n\n${result}`,
        },
      ],
    };
  }

  private async handleAsciiShapes(args: any): Promise<any> {
    const shape = args.shape || 'triangle';
    const size = Math.max(3, Math.min(25, args.size || 5));
    const filled = args.filled || false;

    let result = '';

    switch (shape) {
      case 'triangle':
        for (let i = 0; i < size; i++) {
          const spaces = ' '.repeat(size - i - 1);
          if (filled || i === 0 || i === size - 1) {
            result += spaces + '█'.repeat(2 * i + 1) + '\n';
          } else {
            result += spaces + '█' + ' '.repeat(2 * i - 1) + (i > 0 ? '█' : '') + '\n';
          }
        }
        break;

      case 'diamond':
        // Top half
        for (let i = 0; i < size; i++) {
          const spaces = ' '.repeat(size - i - 1);
          if (filled || i === 0) {
            result += spaces + '█'.repeat(2 * i + 1) + '\n';
          } else {
            result += spaces + '█' + ' '.repeat(2 * i - 1) + (i > 0 ? '█' : '') + '\n';
          }
        }
        // Bottom half
        for (let i = size - 2; i >= 0; i--) {
          const spaces = ' '.repeat(size - i - 1);
          if (filled || i === 0) {
            result += spaces + '█'.repeat(2 * i + 1) + '\n';
          } else {
            result += spaces + '█' + ' '.repeat(2 * i - 1) + (i > 0 ? '█' : '') + '\n';
          }
        }
        break;

      case 'circle':
        const radius = size;
        for (let y = -radius; y <= radius; y++) {
          let row = '';
          for (let x = -radius; x <= radius; x++) {
            const distance = Math.sqrt(x * x + y * y);
            if (filled ? distance <= radius : Math.abs(distance - radius) < 0.8) {
              row += '█';
            } else {
              row += ' ';
            }
          }
          result += row.trimEnd() + '\n';
        }
        break;

      case 'star':
        const star = [
          '    ★    ',
          '   ███   ',
          '  █████  ',
          ' ███████ ',
          '█████████',
          ' ███████ ',
          '  █████  ',
          '   ███   ',
          '   ███   ',
          '   ███   ',
        ];
        result = star.slice(0, Math.min(size, star.length)).join('\n');
        break;

      case 'heart':
        const heart = [
          ' ██   ██ ',
          '█████████',
          '█████████',
          ' ███████ ',
          '  █████  ',
          '   ███   ',
          '    █    ',
        ];
        result = heart.slice(0, Math.min(size, heart.length)).join('\n');
        break;

      case 'arrow':
        for (let i = 0; i < size; i++) {
          const spaces = ' '.repeat(i);
          result += spaces + '█'.repeat(size - i) + '\n';
        }
        for (let i = size - 2; i >= 0; i--) {
          const spaces = ' '.repeat(i);
          result += spaces + '█'.repeat(size - i) + '\n';
        }
        break;
    }

    return {
      content: [
        {
          type: 'text',
          text: `🔷 ASCII ${shape} (size: ${size}, ${filled ? 'filled' : 'outline'}):\n\n${result}`,
        },
      ],
    };
  }

  private async handleTextEffects(args: any): Promise<any> {
    const text = args.text || '';
    const effect = args.effect || 'mirror';

    if (!text) {
      throw new McpError(ErrorCode.InvalidParams, 'Text is required for effects');
    }

    let result = '';

    switch (effect) {
      case 'mirror':
        result = text + ' | ' + text.split('').reverse().join('');
        break;

      case 'reverse':
        result = text.split('').reverse().join('');
        break;

      case 'upside_down':
        const upsideDownMap: Record<string, string> = {
          a: 'ɐ',
          b: 'q',
          c: 'ɔ',
          d: 'p',
          e: 'ǝ',
          f: 'ɟ',
          g: 'ƃ',
          h: 'ɥ',
          i: 'ı',
          j: 'ɾ',
          k: 'ʞ',
          l: 'l',
          m: 'ɯ',
          n: 'u',
          o: 'o',
          p: 'd',
          q: 'b',
          r: 'ɹ',
          s: 's',
          t: 'ʇ',
          u: 'n',
          v: 'ʌ',
          w: 'ʍ',
          x: 'x',
          y: 'ʎ',
          z: 'z',
          ' ': ' ',
        };
        result = text
          .toLowerCase()
          .split('')
          .map((c: string) => upsideDownMap[c] || c)
          .reverse()
          .join('');
        break;

      case 'wave':
        result = text
          .split('')
          .map((char: string, i: number) => {
            if (i % 2 === 0) return char.toUpperCase();
            return char.toLowerCase();
          })
          .join('');
        break;

      case 'stairs':
        result = text
          .split('')
          .map((char: string, i: number) => ' '.repeat(i) + char)
          .join('\n');
        break;

      case 'zigzag':
        const lines = ['', ''];
        text.split('').forEach((char: string, i: number) => {
          if (i % 2 === 0) {
            lines[0] += char + ' ';
            lines[1] += '  ';
          } else {
            lines[0] += '  ';
            lines[1] += char + ' ';
          }
        });
        result = lines.join('\n');
        break;
    }

    return {
      content: [
        {
          type: 'text',
          text: `✨ Text Effect (${effect}):\n\nOriginal: ${text}\nResult:\n${result}`,
        },
      ],
    };
  }

  private async handleRandomArt(args: any): Promise<any> {
    const type = args.type || 'pattern';
    const width = Math.max(10, Math.min(80, args.width || 40));
    const height = Math.max(5, Math.min(30, args.height || 15));

    let result = '';

    switch (type) {
      case 'pattern':
        const chars = ['█', '▓', '▒', '░', '·', '•', '◦', '○', '●'];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const index = (x + y) % chars.length;
            result += chars[index];
          }
          result += '\n';
        }
        break;

      case 'mandala':
        const centerX = Math.floor(width / 2);
        const centerY = Math.floor(height / 2);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const dx = x - centerX;
            const dy = y - centerY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx);
            const pattern = Math.sin(distance + angle * 8) > 0 ? '●' : '○';
            result += pattern;
          }
          result += '\n';
        }
        break;

      case 'maze':
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (x % 2 === 0 || y % 2 === 0) {
              result += '█';
            } else {
              result += Math.random() > 0.3 ? ' ' : '█';
            }
          }
          result += '\n';
        }
        break;

      case 'abstract':
        const abstractChars = ['▀', '▄', '▌', '▐', '█', '░', '▒', '▓'];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const noise = Math.sin(x * 0.1) * Math.cos(y * 0.15) + Math.random() * 0.5;
            const charIndex =
              Math.floor(((noise + 1) * abstractChars.length) / 2) % abstractChars.length;
            result += abstractChars[charIndex];
          }
          result += '\n';
        }
        break;

      case 'landscape':
        // Generate a simple mountain landscape
        const heights = [];
        for (let x = 0; x < width; x++) {
          const mountainHeight = Math.floor(
            height * 0.7 * (1 + Math.sin(x * 0.1) * 0.3 + Math.sin(x * 0.05) * 0.5)
          );
          heights.push(Math.max(0, Math.min(height - 1, mountainHeight)));
        }

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (y < height - heights[x]) {
              result += ' ';
            } else if (y === height - heights[x]) {
              result += '^';
            } else {
              result += '█';
            }
          }
          result += '\n';
        }
        break;
    }

    return {
      content: [
        {
          type: 'text',
          text: `🎲 Random ASCII Art (${type}, ${width}×${height}):\n\n${result}`,
        },
      ],
    };
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[ASCII Art MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      console.log('\n🎨 Shutting down ASCII Art Generator MCP server...');
      await this.server.close();
      process.exit(0);
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('🎨 ASCII Art Generator MCP server started successfully!');
    console.log('Available tools: text_banner, draw_box, ascii_shapes, text_effects, random_art');
  }
}

// Start the server
async function main() {
  try {
    const server = new AsciiArtGeneratorMCPServer();
    await server.start();
  } catch (error) {
    console.error('❌ Failed to start ASCII Art Generator MCP server:', error);
    process.exit(1);
  }
}

// ES module entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { AsciiArtGeneratorMCPServer };
