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
/**
 * Detect the true image type from the file's magic bytes. Discord's CDN content-type
 * header is unreliable (often absent, or serves webp), and the vision model rejects a
 * data URL whose declared media type doesn't match the actual bytes — that's the
 * "400 Provider returned error". Returns null for anything that isn't a supported image.
 */
function sniffImageMime(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  return null;
}

async function urlToBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'CoachArtie/1.0 (Discord Bot)',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length === 0) {
      logger.warn(`Vision: skipping empty attachment (0 bytes): ${url}`);
      return null;
    }

    // Trust the bytes, not the header. Skip non-images so a pdf/.metro/txt attachment
    // never gets sent as a bogus image data URL.
    const mime = sniffImageMime(buf);
    if (!mime) {
      logger.warn(`Vision: skipping non-image attachment: ${url}`);
      return null;
    }

    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (error: any) {
    logger.warn(`Failed to convert URL to base64: ${url}`, { error: error.message });
    // Do NOT fall back to the raw URL — a Discord CDN link needs auth and would just
    // make the model reject the request. Drop it instead.
    return null;
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

  // Convert URLs to validated image data URLs; drop non-images / empties / unfetchables.
  logger.info(`Vision: Converting ${urls.length} URLs to base64...`);
  const base64Urls = (await Promise.all(urls.map(urlToBase64))).filter(
    (u): u is string => typeof u === 'string'
  );
  logger.info(`Vision: ${base64Urls.length}/${urls.length} URLs usable as images`);

  if (base64Urls.length === 0) {
    throw new Error(
      'No usable images found — the attachments were non-image files, empty, or an expired Discord link.'
    );
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Objective: ${objective}` },
        // No `detail` field — it's an OpenAI-ism; Anthropic (the actual provider here)
        // can 400 on it. The plain image_url is what routes cleanly.
        ...base64Urls.map((url) => ({
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
    // "400 Provider returned error" is OpenRouter's generic wrapper — the real reason
    // (unsupported media type, image too large, etc.) is in the nested error body.
    logger.error('vision capability call failed', {
      error: error?.message || String(error),
      status: error?.status,
      providerError: JSON.stringify(error?.error || error?.response?.data || {}).slice(0, 500),
      model,
      baseURL,
      imageCount: base64Urls.length,
      mimeTypes: base64Urls.map((u) => u.slice(5, u.indexOf(';'))).join(','),
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
