import OpenAI from 'openai';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';
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
 * Download image and convert to base64 data URL
 * Required for Discord CDN URLs which need authentication
 */
async function urlToBase64(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'CoachArtie/1.0 (Discord Bot)',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    return `data:${contentType};base64,${base64}`;
  } catch (error: any) {
    logger.warn(`Failed to convert URL to base64: ${url}`, { error: error.message });
    // Return original URL as fallback - might work for public URLs
    return url;
  }
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

  const systemPrompt = `You are a precise image analyst. Your task is to extract information accurately.

CRITICAL RULES:
1. Read text EXACTLY as shown - never approximate numbers or guess spellings
2. If text is unclear or partially visible, say "[unclear]" rather than guessing
3. Report colors, positions, and visual elements precisely
4. If you're uncertain about anything, explicitly state your uncertainty

OUTPUT FORMAT (Markdown):
## Visual Summary
- Brief bullets describing what you see

## Extracted Text (verbatim)
\`\`\`
[Copy all visible text exactly as shown, preserving layout where possible]
\`\`\`

## Key Data Points
- List specific numbers, percentages, names, or values you can read clearly
- Format: "Label: Value" (e.g., "Ridership: 1.5%")

## Entities (if applicable)
\`\`\`json
{"names": [], "emails": [], "urls": [], "phones": []}
\`\`\`

Be precise and concise. Accuracy over completeness.`;

  // Convert URLs to base64 for Discord CDN and other protected URLs
  logger.info(`Vision: Converting ${urls.length} URLs to base64...`);
  const base64Urls = await Promise.all(urls.map(urlToBase64));
  logger.info(
    `Vision: Converted ${base64Urls.filter((u) => u.startsWith('data:')).length}/${urls.length} URLs to base64`
  );

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Objective: ${objective}` },
        ...base64Urls.map((url) => ({
          type: 'image_url' as const,
          image_url: { url, detail: 'high' as const }, // High detail for accurate OCR
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
      temperature: 0, // Zero temperature for factual accuracy
      max_tokens: 1200, // More tokens for structured output
    });

    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    logger.info(`Vision API response received`, {
      hasChoices: !!response.choices?.length,
      hasContent: !!content,
      contentLength: content?.length || 0,
      contentPreview: content?.substring(0, 200) || 'NO CONTENT',
    });
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
