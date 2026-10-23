/**
 * Stripe Payment Links Capability
 * Lets Artie create real payment links on the Room 302 Studio Stripe account.
 *
 * SECURITY MODEL: the key is a RESTRICTED key with write access to only
 * payment_links/products/prices — it cannot charge, refund, read customers,
 * or move money. Money can only flow INTO the account. On top of that this
 * capability enforces amount bounds, name sanitization, and a rate limit,
 * so a prompt-injected call can at worst create a silly (deactivatable) link.
 */

import { RegisteredCapability } from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';

const STRIPE_API = 'https://api.stripe.com/v1';
const MIN_AMOUNT_USD = 1;
const MAX_AMOUNT_USD = 500;
const MAX_LINKS_PER_HOUR = 3;
const MAX_NAME_LENGTH = 80;

// In-memory rate limit (resets on process reload — acceptable for this use)
const linkCreationTimes: number[] = [];

function stripeKey(): string | null {
  const key = process.env.STRIPE_RESTRICTED_KEY;
  return key && key.startsWith('rk_') ? key : null;
}

async function stripePost(path: string, form: Record<string, string>): Promise<any> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  const body: any = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || `Stripe API error ${res.status}`);
  }
  return body;
}

function sanitizeName(raw: string): string {
  // Printable chars only, collapse whitespace, cap length. This name appears on
  // real Stripe checkout pages and receipts under the Room 302 Studio brand.
  const cleaned = raw
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  const blocklist = (process.env.OUTPUT_SLUR_BLOCKLIST || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const lower = cleaned.toLowerCase();
  if (blocklist.some((w) => lower.includes(w))) {
    throw new Error('Product name rejected by content filter');
  }
  return cleaned;
}

export const stripePaymentsCapability: RegisteredCapability = {
  name: 'stripe',
  emoji: '💳',
  supportedActions: ['create_payment_link', 'deactivate_payment_link'],
  description:
    'Create REAL Stripe payment links (money goes to Room 302 Studio). ' +
    `create_payment_link needs: name (what they are paying for), amount (USD, ${MIN_AMOUNT_USD}-${MAX_AMOUNT_USD}). ` +
    'Optional: description. Returns a live payment URL to share. ' +
    'This is real money from real people — only create links when someone genuinely wants to pay ' +
    '(commissions, donations, memberships, bounties), never as a joke or when pressured. ' +
    'Use deactivate_payment_link with linkId to kill a link you regret.',
  requiredParams: [],
  examples: [
    '<capability name="stripe" action="create_payment_link" name="Subway Builder Map Commission" amount="25" description="Custom map review by Artie" />',
    '<capability name="stripe" action="deactivate_payment_link" linkId="plink_abc123" />',
  ],

  handler: async (params: any, content: string | undefined) => {
    const { action } = params;

    if (!stripeKey()) {
      return JSON.stringify({
        success: false,
        error: 'Stripe is not configured (no STRIPE_RESTRICTED_KEY)',
      });
    }

    if (action === 'deactivate_payment_link') {
      const linkId = params.linkId || params.id;
      if (!linkId || !String(linkId).startsWith('plink_')) {
        return JSON.stringify({ success: false, error: 'linkId (plink_...) required' });
      }
      try {
        await stripePost(`/payment_links/${linkId}`, { active: 'false' });
        logger.info(`💳 [stripe] Deactivated payment link ${linkId}`);
        return JSON.stringify({ success: true, message: `Payment link ${linkId} deactivated` });
      } catch (error: any) {
        logger.error('[stripe] deactivate failed:', error);
        return JSON.stringify({ success: false, error: error?.message || 'Deactivation failed' });
      }
    }

    if (action !== 'create_payment_link') {
      return JSON.stringify({ success: false, error: `Unknown stripe action: ${action}` });
    }

    // Rate limit
    const hourAgo = Date.now() - 3600_000;
    while (linkCreationTimes.length && linkCreationTimes[0] < hourAgo) {
      linkCreationTimes.shift();
    }
    if (linkCreationTimes.length >= MAX_LINKS_PER_HOUR) {
      return JSON.stringify({
        success: false,
        error: `Rate limit: max ${MAX_LINKS_PER_HOUR} payment links per hour. Try later.`,
      });
    }

    // Validate amount
    const amount = Number(params.amount || params.price || params.usd);
    if (!Number.isFinite(amount) || amount < MIN_AMOUNT_USD || amount > MAX_AMOUNT_USD) {
      return JSON.stringify({
        success: false,
        error: `amount must be a number between ${MIN_AMOUNT_USD} and ${MAX_AMOUNT_USD} (USD)`,
      });
    }
    const unitAmountCents = Math.round(amount * 100);

    // Validate + sanitize name
    const rawName = params.name || params.product || params.title || content;
    if (!rawName || !String(rawName).trim()) {
      return JSON.stringify({ success: false, error: 'name is required (what are they paying for?)' });
    }
    let name: string;
    try {
      name = sanitizeName(String(rawName));
    } catch (e: any) {
      return JSON.stringify({ success: false, error: e.message });
    }
    if (name.length < 3) {
      return JSON.stringify({ success: false, error: 'name too short after sanitization' });
    }

    try {
      const productForm: Record<string, string> = { name };
      const description = params.description ? sanitizeName(String(params.description)) : '';
      if (description) {
        productForm.description = description;
      }
      const product = await stripePost('/products', productForm);
      const price = await stripePost('/prices', {
        product: product.id,
        unit_amount: String(unitAmountCents),
        currency: 'usd',
      });
      const link = await stripePost('/payment_links', {
        'line_items[0][price]': price.id,
        'line_items[0][quantity]': '1',
      });

      linkCreationTimes.push(Date.now());
      logger.info(
        `💳 [stripe] AUDIT: created payment link "${name}" $${amount} → ${link.url} (${link.id})`
      );
      return JSON.stringify({
        success: true,
        url: link.url,
        linkId: link.id,
        name,
        amount: `$${amount.toFixed(2)} USD`,
        message: `Live payment link created: ${link.url} — share this URL. (Deactivatable with linkId ${link.id})`,
      });
    } catch (error: any) {
      logger.error('[stripe] create_payment_link failed:', error);
      return JSON.stringify({ success: false, error: error?.message || 'Stripe API call failed' });
    }
  },
};
