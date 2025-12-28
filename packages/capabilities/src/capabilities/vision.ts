import OpenAI from 'openai';
import { RegisteredCapability } from '../services/capability-registry.js';
import { logger } from '@coachartie/shared';

interface VisionParams {
  action: 'extract';
  urls?: string[] | string;
  objective?: string;
}

function normalizeUrls(urls?: string[] | string): string[] {
  if (!urls) return [];
  if (typeof urls === 'string') {
    try {
      const parsed = JSON.parse(urls);
      if (Array.isArray(parsed)) return parsed.map((u) => String(u));
    } catch (_) {
      // Fall through
    }
    return [urls];
  }
  return urls;
}

/**
 * Vision capability - orchestrates OCR/vision via OpenRouter vision models.
 */
async function handleVision(params: VisionParams): Promise<string> {
  const urls = normalizeUrls(params.urls);

  if (urls.length === 0) {
    throw new Error('No URLs provided. Pass one or more image/file URLs to extract.');
  }

  const objective = params.objective || 'Extract text and key entities (names, emails, links).';
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not configured. Set it to enable vision. Alternatively, ask the user to paste the text.'
    );
  }

  const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const model =
    process.env.OPENROUTER_VISION_MODEL ||
    process.env.VISION_MODEL ||
    process.env.OPENROUTER_MODELS?.split(',').map((m) => m.trim())[0] ||
    'openai/gpt-4o';

  const client = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: {
      'HTTP-Referer': 'https://coach-artie.local',
      'X-Title': 'Coach Artie',
    },
  });

  const systemPrompt =
    'You extract text and entities from images. Return concise Markdown with:\n' +
    '1) Summary bullets\n' +
    '2) Extracted text block (verbatim OCR where possible)\n' +
    '3) Entities JSON with keys: names[], emails[], urls[], phones[]\n' +
    'Be concise, no filler.';

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Objective: ${objective}` },
        ...urls.map((url) => ({
          type: 'image_url' as const,
          image_url: { url },
        })),
      ],
    },
  ];

  let extracted = '';
  let usage: any = null;

  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: 0,
      max_tokens: 800,
    });

    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      throw new Error('Vision model returned no content.');
    }
    extracted = content;
    usage = response.usage;
  } catch (error: any) {
    logger.error('vision capability call failed', {
      error: error?.message || String(error),
      model,
      baseURL,
    });
    throw new Error(
      `Vision extraction failed with model "${model}". Check OPENROUTER_API_KEY/OPENROUTER_VISION_MODEL. Error: ${error?.message || String(error)}`
    );
  }

  const summaryLines = [
    '🎯 VISION EXTRACTION COMPLETE',
    '',
    '📊 Summary:',
    `- Objective: ${objective}`,
    `- Attachments: ${urls.length}`,
    `- Model: ${model}`,
    '',
    '📋 Attachments (processed):',
  ];

  urls.forEach((url, idx) => {
    summaryLines.push(`${idx + 1}. ${url}`);
  });

  summaryLines.push('');
  summaryLines.push('🧾 Extracted Text & Entities:');
  summaryLines.push(extracted);

  if (usage) {
    summaryLines.push('');
    summaryLines.push('💳 Usage:');
    summaryLines.push(JSON.stringify(usage, null, 2));
  }

  logger.info('vision capability invoked', { urlCount: urls.length, model });
  return summaryLines.join('\n');
}

export const visionCapability: RegisteredCapability = {
  name: 'vision',
  emoji: '👁️',
  supportedActions: ['extract'],
  description:
    'Extract text/entities from images/files using a vision model (OpenRouter). Pass URLs to extract.',
  requiredParams: ['urls'],
  examples: [
    '<vision-extract urls="https://example.com/image.png" />',
    '<vision-extract urls=\'["https://example.com/img1.png", "https://example.com/img2.png"]\' objective="Extract all text" />',
  ],
  handler: async (params, content) => {
    const { action, urls, objective } = params;
    const visionParams: VisionParams = {
      action: action as 'extract',
      urls: urls || content,
      objective,
    };

    switch (action) {
      case 'extract':
        return handleVision(visionParams);
      default:
        throw new Error(
          `Unsupported action: ${action}. Use action="extract" with urls:[...]. Example: <vision-extract urls="https://..." />`
        );
    }
  },
};
