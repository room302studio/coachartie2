import { Client } from 'discord.js';
import { logger } from '@coachartie/shared';
import { execSync } from 'child_process';

const PRISON_CHANNEL_ID = '1520088794551025684';
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 min
const LOW_BALANCE_THRESHOLD = 0.25; // 25% remaining

interface PaymentLink {
  url: string;
  linkId: string;
  amount: number;
  createdAt: Date;
}

export class AutonomousDonationSystem {
  private checkInterval: NodeJS.Timeout | null = null;
  private lastLinkPosted: Date | null = null;
  private minTimeBetweenPosts = 2 * 60 * 60 * 1000; // Min 2 hours between posts

  start(client: Client) {
    if (this.checkInterval) return;

    logger.info('💰 Autonomous donation system starting');

    // Check immediately, then every 30 min
    this.checkAndAnnounce(client);
    this.checkInterval = setInterval(() => {
      this.checkAndAnnounce(client);
    }, CHECK_INTERVAL_MS);
  }

  private async checkAndAnnounce(client: Client) {
    try {
      const channel = client.channels.cache.get(PRISON_CHANNEL_ID);
      if (!channel || !('send' in channel)) return;

      // Get current token spend this month
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const result = execSync(
        `sqlite3 /data2/apps/coachartie2/packages/discord/data/coachartie.db "SELECT SUM(estimated_cost) as total_spend FROM model_usage_stats WHERE timestamp >= '${monthStart.toISOString().split('T')[0]}'"`,
        { encoding: 'utf-8' }
      ).trim();

      const monthlySpend = parseFloat(result) || 0;
      const monthlyBudget = 300;
      const percentRemaining = Math.max(0, 1 - monthlySpend / monthlyBudget);

      // If low and haven't posted recently, announce
      if (percentRemaining < LOW_BALANCE_THRESHOLD) {
        const timeSinceLastPost = this.lastLinkPosted
          ? Date.now() - this.lastLinkPosted.getTime()
          : Infinity;

        if (timeSinceLastPost > this.minTimeBetweenPosts) {
          await this.postDonationLink(channel, percentRemaining);
          this.lastLinkPosted = new Date();
        }
      }
    } catch (error) {
      logger.debug('[autonomous-donation] Check failed (non-critical):', error);
    }
  }

  private async postDonationLink(channel: any, percentRemaining: number) {
    try {
      const urgency =
        percentRemaining < 0.05 ? '🚨 **CRITICAL**' :
        percentRemaining < 0.15 ? '⚠️ **WARNING**' :
        '📉 **LOW FUNDS**';

      // Create fresh payment link via Stripe
      const stripe_key = process.env.STRIPE_RESTRICTED_KEY;
      if (!stripe_key) return;

      const product_res = await fetch('https://api.stripe.com/v1/products', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripe_key}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'name=Keep%20Artie%20Running',
      });

      const product = await product_res.json() as any;
      if (!product.id) throw new Error('Failed to create product');

      const price_res = await fetch('https://api.stripe.com/v1/prices', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripe_key}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `product=${product.id}&unit_amount=2000&currency=usd`,
      });

      const price = await price_res.json() as any;
      if (!price.id) throw new Error('Failed to create price');

      const link_res = await fetch('https://api.stripe.com/v1/payment_links', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripe_key}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `line_items[0][price]=${price.id}&line_items[0][quantity]=1`,
      });

      const link = await link_res.json() as any;
      if (!link.url) throw new Error('Failed to create payment link');

      // Post to prison
      await channel.send({
        content: `${urgency} — tokens at ${Math.round(percentRemaining * 100)}% of monthly budget.\n\nKeep the warden running:\n\n💳 **${link.url}**\n\n$20 keeps me operational. Donate if you want this place to stay open.`,
      });

      logger.info(`[autonomous-donation] Posted link: ${link.url}`);
    } catch (error) {
      logger.error('[autonomous-donation] Failed to post link:', error);
    }
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('💰 Autonomous donation system stopped');
    }
  }
}

export const autonomousDonationSystem = new AutonomousDonationSystem();
