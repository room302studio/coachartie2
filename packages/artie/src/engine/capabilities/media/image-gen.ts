import { RegisteredCapability, CapabilityContext } from '../registry.js';
import { logger } from '../../../shared/logger.js';
import { assertGenerationAllowed } from '../../../shared/kill-switch.js';
import { addPendingAttachment } from '../../3-context/assemble.js';
import { isOwner } from '../../../shared/config/owner.js';
import { getBrownoutMode } from '../../budget/brownout.js';
import { getUserActionCountToday } from '../../budget/daily-cap.js';
import { UsageLedger } from '../../budget/usage-ledger.js';

/** ARTIE_IMAGE_GEN_PER_USER_DAY, default 3. The owner is exempt (security audit 2026-10-26,
 * sec-abuse.md Critical #3: image_gen spend was invisible to the daily budget ledger and had
 * no per-user limit — an uncapped wallet drain for any of the 16k+ guild members). */
function imageGenPerUserDailyCap(): number {
  const parsed = parseInt(String(process.env.ARTIE_IMAGE_GEN_PER_USER_DAY ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 3;
}

/** The injected params.messageId as a turn id, or '' when absent. */
function optionalTurnId(messageId: unknown): string {
  if (messageId) {
    return String(messageId);
  }
  return '';
}

interface ImageGenParams {
  action: 'generate' | 'edit';
  prompt: string;
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  size?: '1K' | '2K' | '4K';
  input_image?: string; // URL or base64 for editing
}

/**
 * Download image and convert to base64 data URL
 */
async function urlToBase64(url: string): Promise<string> {
  if (url.startsWith('data:')) return url; // Already base64

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CoachArtie/1.0 (Discord Bot)' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch (error: any) {
    logger.warn(`Failed to convert URL to base64: ${url}`, { error: error.message });
    return url;
  }
}

/**
 * Image generation using Nano Banana (Gemini) via OpenRouter
 */
async function handleImageGen(params: ImageGenParams): Promise<{
  text: string;
  imageBase64?: string;
  imageBuffer?: Buffer;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }

  const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.IMAGE_GEN_MODEL || 'google/gemini-3.1-flash-image-preview';

  logger.info(`Image generation: ${params.action} with model ${model}`);

  // Build the request - OpenRouter uses OpenAI-compatible API with extra params
  const requestBody: any = {
    model,
    messages: [],
    modalities: ['text', 'image'], // Enable image output
    // Ask OpenRouter for the real USD cost on the response (usage-ledger.ts's
    // openrouter.ts does the same for chat generations) so image spend can be billed
    // accurately instead of guessed.
    usage: { include: true },
  };

  // Add image config for aspect ratio and size
  if (params.aspect_ratio || params.size) {
    requestBody.image_config = {};
    if (params.aspect_ratio) {
      requestBody.image_config.aspect_ratio = params.aspect_ratio;
    }
    if (params.size) {
      requestBody.image_config.image_size = params.size;
    }
  }

  // Build message content
  const userContent: any[] = [{ type: 'text', text: params.prompt }];

  // For editing, include the input image
  if (params.action === 'edit' && params.input_image) {
    const base64Image = await urlToBase64(params.input_image);
    userContent.unshift({
      type: 'image_url',
      image_url: { url: base64Image },
    });
  }

  requestBody.messages = [
    {
      role: 'user',
      content: userContent,
    },
  ];

  // Make the API call (never while the kill switch / budget mute is on)
  assertGenerationAllowed('image-gen');
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://coach-artie.local',
      'X-Title': 'Coach Artie',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
        images?: string[];
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
    };
  };
  const choice = data.choices?.[0];
  const message = choice?.message;

  if (!message) {
    throw new Error('No response from image generation model');
  }

  // Extract text and images from response
  let textContent = '';
  let imageBase64: string | undefined;
  let imageBuffer: Buffer | undefined;

  // Handle different response formats
  if (typeof message.content === 'string') {
    textContent = message.content;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        textContent += part.text;
      } else if (part.type === 'image_url' && part.image_url?.url) {
        imageBase64 = part.image_url.url;
      }
    }
  }

  // Check for images field (OpenRouter format)
  // Format: images: [{ type: "image_url", image_url: { url: "data:image/png;base64,..." }, index: 0 }]
  if (message.images && Array.isArray(message.images) && message.images.length > 0) {
    const img = message.images[0] as unknown;
    logger.info(`Image object from API: ${JSON.stringify(img).substring(0, 200)}`);

    if (typeof img === 'string') {
      imageBase64 = img;
    } else if (img && typeof img === 'object') {
      const imgObj = img as Record<string, unknown>;

      // OpenRouter Gemini format: { type: "image_url", image_url: { url: "data:..." } }
      if (imgObj.image_url && typeof imgObj.image_url === 'object') {
        const imageUrlObj = imgObj.image_url as Record<string, unknown>;
        if (typeof imageUrlObj.url === 'string') {
          imageBase64 = imageUrlObj.url;
          logger.info(`Extracted image from image_url.url format`);
        }
      }
      // Direct url format
      else if ('url' in imgObj && typeof imgObj.url === 'string') {
        imageBase64 = imgObj.url;
      }
      // OpenAI b64_json format
      else if ('b64_json' in imgObj && typeof imgObj.b64_json === 'string') {
        imageBase64 = `data:image/png;base64,${imgObj.b64_json}`;
      }
      // Raw data format
      else if ('data' in imgObj && typeof imgObj.data === 'string') {
        imageBase64 = `data:image/png;base64,${imgObj.data}`;
      } else {
        logger.warn(`Unknown image format, keys: ${Object.keys(imgObj).join(', ')}`);
      }
    }
    logger.info(
      `Image extraction: imageBase64Set=${!!imageBase64}, length=${imageBase64?.length || 0}`
    );
  }

  // Convert base64 to buffer if we have an image
  if (imageBase64 && typeof imageBase64 === 'string') {
    // Extract base64 data from data URL if present
    const base64Match = imageBase64.match(/^data:image\/\w+;base64,(.+)$/);
    if (base64Match) {
      imageBuffer = Buffer.from(base64Match[1], 'base64');
    } else if (!imageBase64.startsWith('http')) {
      // Assume it's raw base64
      imageBuffer = Buffer.from(imageBase64, 'base64');
      imageBase64 = `data:image/png;base64,${imageBase64}`;
    }
  }

  logger.info(
    `Image generation complete: hasImage=${!!imageBuffer}, textLength=${textContent.length}`
  );

  return {
    text: textContent || 'Image generated successfully.',
    imageBase64,
    imageBuffer,
    model,
    usage: data.usage,
  };
}

export const imageGenCapability: RegisteredCapability = {
  name: 'image_gen',
  emoji: '🎨',
  supportedActions: ['generate', 'edit'],
  description:
    'Generate or edit images using Nano Banana (Gemini) via OpenRouter. Can create images from text prompts or edit existing images.',
  requiredParams: ['prompt'],
  examples: [
    '<image_gen-generate prompt="A cute robot playing chess" />',
    '<image_gen-generate prompt="A futuristic cityscape" aspect_ratio="16:9" />',
    '<image_gen-edit prompt="Add a rainbow in the sky" input_image="https://..." />',
  ],
  handler: async (params: Record<string, any>, content?: string, context?: CapabilityContext) => {
    const { action, prompt, aspect_ratio, size, input_image, userId } = params;
    const callerIsOwner = isOwner(String(userId || ''));

    // Security audit 2026-10-26 (sec-abuse.md Critical #3): under brownout `critical`,
    // real-money image generation is refused for anyone but EJ — the same posture as the
    // daily budget mute, applied early instead of waiting for the hard cap to trip.
    if (!callerIsOwner) {
      const brownout = await getBrownoutMode();
      if (brownout.mode === 'critical') {
        return "Image generation is paused while we're running lean on credits — ask EJ, or try again later.";
      }
    }

    // Per-user daily cap (ARTIE_IMAGE_GEN_PER_USER_DAY, default 3). The owner is exempt.
    if (!callerIsOwner && userId) {
      const cap = imageGenPerUserDailyCap();
      const usedToday = getUserActionCountToday(String(userId), 'image_gen');
      if (usedToday >= cap) {
        return `You've hit today's image generation limit (${cap}/day). Try again after midnight ET, or ask EJ.`;
      }
    }

    const result = await handleImageGen({
      action: (action as 'generate' | 'edit') || 'generate',
      prompt: prompt || content || 'Generate an interesting image',
      aspect_ratio: aspect_ratio as ImageGenParams['aspect_ratio'],
      size: size as ImageGenParams['size'],
      input_image,
    });

    // Security audit 2026-10-26 (sec-abuse.md Critical #3): image_gen spend used to be
    // invisible to the daily budget ledger (model_usage_stats), so it never counted toward
    // DAILY_BUDGET_USD and never tripped the auto-mute. Record it the same way openrouter.ts
    // does for chat generations — reported cost when OpenRouter gave one, else the standard
    // top-tier-for-unknown-model fallback in UsageLedger.calculateCost.
    const usage = result.usage;
    const tokenUsage = {
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
    };
    let estimatedCost: number;
    if (Number.isFinite(usage?.cost)) {
      estimatedCost = Number(usage!.cost);
    } else {
      estimatedCost = UsageLedger.calculateCost(result.model, tokenUsage);
    }
    void UsageLedger.recordUsage({
      model_name: result.model,
      user_id: String(userId || 'unknown-user'),
      message_id: String(params.messageId || ''),
      input_length: String(prompt || content || '').length,
      output_length: result.text.length,
      response_time_ms: 0,
      capabilities_detected: 0,
      capabilities_executed: 1,
      capability_types: 'image_gen',
      success: true,
      prompt_tokens: tokenUsage.prompt_tokens,
      completion_tokens: tokenUsage.completion_tokens,
      total_tokens: tokenUsage.total_tokens,
      estimated_cost: estimatedCost,
      guild_id: context?.guildId ?? null,
      step_type: 'image_gen',
    });

    // Queue the image on THIS turn's reply (keyed by turn id, not user: 2026-10-31)
    const turnId = context?.messageId || optionalTurnId(params.messageId);
    if (result.imageBuffer && turnId) {
      const filename = `artie-${Date.now()}.png`;
      addPendingAttachment(turnId, {
        buffer: result.imageBuffer,
        filename,
        content: `🎨 Here's your generated image!`,
      });
      logger.info(
        `📎 Queued generated image for sending: ${filename} (${result.imageBuffer.length} bytes)`
      );

      return `🎨 Image Generated!\n\n${result.text}`;
    } else if (result.imageBuffer) {
      // No turn to attach to - log warning but still return success
      logger.warn('Image generated but no turn id available for pending attachment');
      return `🎨 Image Generated!\n\n${result.text}\n\n(Note: Image couldn't be attached - no reply context)`;
    }

    return result.text;
  },
};
