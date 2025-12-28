import { logger, IncomingMessage } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';
import { contextAlchemy } from './context-alchemy.js';
import { promptManager } from './prompt-manager.js';

// =====================================================
// EMAIL DRAFTING SERVICE
// =====================================================

export interface EmailDraft {
  id: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
  originalRequest: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  status: 'draft' | 'approved' | 'sent' | 'cancelled';
}

export class EmailDraftingService {
  private static instance: EmailDraftingService;
  private emailDrafts = new Map<string, EmailDraft>(); // userId -> current draft

  static getInstance(): EmailDraftingService {
    if (!EmailDraftingService.instance) {
      EmailDraftingService.instance = new EmailDraftingService();
    }
    return EmailDraftingService.instance;
  }

  /**
   * Get current draft for a user
   */
  getDraft(userId: string): EmailDraft | undefined {
    return this.emailDrafts.get(userId);
  }

  /**
   * Delete draft for a user
   */
  deleteDraft(userId: string): void {
    this.emailDrafts.delete(userId);
  }

  /**
   * Detect email intent from user message
   */
  async detectEmailIntent(
    message: string,
    userId?: string
  ): Promise<{ to: string; subject?: string; about?: string } | null> {
    const lowerMessage = message.toLowerCase();

    // Pattern 1: "email me" - lookup user's linked email
    if (/\b(email|send)\s+(me|myself)\b/.test(lowerMessage) && userId) {
      try {
        // Use unified profile system
        const { UserProfileService } = await import('@coachartie/shared');
        const email = await UserProfileService.getAttribute(userId, 'email');

        if (email) {
          // Extract topic from "email me this later" or "email me about X"
          const aboutMatch = message.match(/about (.+?)(?:\.|$)/i);
          const thisMatch = message.match(/me\s+(this|that)\s+(.+?)(?:\.|$)/i);

          return {
            to: email,
            about: aboutMatch?.[1] || thisMatch?.[2],
          };
        } else {
          // User hasn't linked email - could prompt them
          logger.info('User requested "email me" but has no linked email', { userId });
          return null;
        }
      } catch (error) {
        logger.error('Failed to lookup user email:', error);
        return null;
      }
    }

    // Pattern 2: Explicit email address
    const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
    const emailMatch = message.match(emailRegex);

    if (!emailMatch) return null;

    // Must have action verb BEFORE the email address (not just "is my email")
    const emailAddress = emailMatch[0];
    const emailIndex = message.indexOf(emailAddress);
    const textBeforeEmail = message.substring(0, emailIndex).toLowerCase();

    // Check for action verbs before the email
    const hasActionVerb =
      /\b(email|send|write|compose|draft)\b/.test(textBeforeEmail) ||
      /\b(send|write).*(to|an email)/.test(textBeforeEmail);

    // Exclude patterns like "my email is" or "email is"
    const isDeclarative = /\b(my email|email)\s+(is|:)\s*$/.test(textBeforeEmail.trim());

    if (hasActionVerb && !isDeclarative) {
      const to = emailAddress;

      // Try to extract subject/topic
      const aboutMatch = message.match(/about (.+?)(?:\.|$)/i);
      const askingMatch = message.match(/asking (?:about )?(.+?)(?:\.|$)/i);

      return {
        to,
        about: aboutMatch?.[1] || askingMatch?.[1],
      };
    }

    return null;
  }

  /**
   * Handle email writing mode - creates initial draft
   */
  async handleEmailWritingMode(
    message: IncomingMessage,
    emailIntent: { to: string; subject?: string; about?: string },
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    logger.info(`📧 EMAIL WRITING MODE: to=${emailIntent.to}, about="${emailIntent.about}"`);

    try {
      // 1. Draft the email using Claude Sonnet (SMART_MODEL)
      if (onPartialResponse) {
        onPartialResponse(`📧 Drafting email to ${emailIntent.to}...\n\n`);
      }

      const draftPrompt = `Write a professional email to ${emailIntent.to}${emailIntent.about ? ` about ${emailIntent.about}` : ''}.

User's request: "${message.message}"

Guidelines:
- Professional but friendly tone
- Clear subject line
- Concise body (2-3 paragraphs max)
- Include appropriate greeting and sign-off
- Sign as "Coach Artie" or appropriate based on context

Format your response using XML tags:
<email>
  <subject>Your subject line here</subject>
  <body>Your email body here</body>
</email>`;

      const emailDraftSystemPrompt = (await promptManager.getPrompt('PROMPT_EMAIL_DRAFT'))?.content ||
        'You are Coach Artie, an AI assistant helping draft professional emails.';
      const { messages } = await contextAlchemy.buildMessageChain(
        draftPrompt,
        message.userId,
        emailDraftSystemPrompt
      );

      const smartModel = openRouterService.selectSmartModel();
      const draft = await openRouterService.generateFromMessageChain(
        messages,
        message.userId,
        `${message.id}_email_draft`,
        smartModel
      );

      // 2. Parse the draft using XML parser
      const { subject, body } = this.parseEmailDraft(draft, emailIntent.about || 'Follow-up');

      // 3. Store draft
      const emailDraft: EmailDraft = {
        id: `draft_${message.userId}_${Date.now()}`,
        userId: message.userId,
        to: emailIntent.to,
        subject,
        body,
        originalRequest: message.message,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'draft',
      };

      this.emailDrafts.set(message.userId, emailDraft);
      logger.info(`📝 Stored draft ${emailDraft.id} for user ${message.userId}`);

      // 4. Show draft and ask for approval
      return this.formatDraftDisplay(emailDraft);
    } catch (error) {
      logger.error('❌ Email writing mode failed:', error);
      return `❌ Failed to draft email: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Detect if user message is responding to a draft
   */
  detectDraftResponse(
    message: string
  ): { action: 'send' | 'edit' | 'cancel'; feedback?: string } | null {
    const lowerMessage = message.toLowerCase().trim();

    // Send actions
    if (
      ['send it', 'send', 'yes', 'approve', 'looks good', 'lgtm', 'perfect'].some(
        (phrase) => lowerMessage === phrase || lowerMessage.startsWith(phrase)
      )
    ) {
      return { action: 'send' };
    }

    // Cancel actions
    if (
      ['cancel', 'discard', 'no', 'nevermind', 'never mind'].some(
        (phrase) => lowerMessage === phrase || lowerMessage.startsWith(phrase)
      )
    ) {
      return { action: 'cancel' };
    }

    // Edit actions - capture feedback
    const editMatch = message.match(/^(?:edit|revise|change|update|fix|make it)\s+(.+)/i);
    if (editMatch) {
      return { action: 'edit', feedback: editMatch[1] };
    }

    // General feedback without "edit" keyword
    if (
      lowerMessage.includes('more') ||
      lowerMessage.includes('less') ||
      lowerMessage.includes('shorter') ||
      lowerMessage.includes('longer') ||
      lowerMessage.includes('formal') ||
      lowerMessage.includes('casual')
    ) {
      return { action: 'edit', feedback: message };
    }

    return null;
  }

  /**
   * Handle user response to draft (send, edit, cancel)
   */
  async handleDraftResponse(
    message: IncomingMessage,
    draft: EmailDraft,
    response: { action: 'send' | 'edit' | 'cancel'; feedback?: string },
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    logger.info(`📧 DRAFT RESPONSE: ${response.action} for draft ${draft.id}`);

    switch (response.action) {
      case 'send':
        return await this.handleSendDraft(draft, message, onPartialResponse);

      case 'edit':
        return await this.handleEditDraft(draft, response.feedback!, message, onPartialResponse);

      case 'cancel':
        this.emailDrafts.delete(message.userId);
        logger.info(`🗑️ Cancelled draft ${draft.id}`);
        return '✅ Draft cancelled. No email will be sent.';

      default:
        return 'I didn\'t understand that. Please reply with "send", "edit [changes]", or "cancel".';
    }
  }

  /**
   * Handle sending a draft - final confirmation flow
   */
  private async handleSendDraft(
    draft: EmailDraft,
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    try {
      // Final confirmation step
      if (draft.status === 'draft') {
        draft.status = 'approved';
        draft.updatedAt = new Date();

        if (onPartialResponse) {
          onPartialResponse(`✅ Draft approved!\n\n📤 Sending email to ${draft.to}...\n\n`);
        }

        // Actually send the email using the email capability
        const { emailCapability } = await import('../capabilities/email.js');
        const result = await emailCapability.handler(
          {
            action: 'send',
            to: draft.to,
            subject: draft.subject,
            from: 'artie@coachartiebot.com',
          },
          draft.body
        );

        // Mark as sent and clean up
        draft.status = 'sent';
        this.emailDrafts.delete(message.userId);

        logger.info(`✅ Sent email ${draft.id} to ${draft.to}`);

        return `${result}\n\n📧 **Email sent successfully!**`;
      } else {
        return '❌ This draft has already been processed.';
      }
    } catch (error) {
      logger.error('❌ Failed to send email:', error);
      draft.status = 'draft'; // Reset to draft on failure
      return `❌ Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}\n\nDraft is still available. Reply "send" to try again or "edit" to revise.`;
    }
  }

  /**
   * Handle editing a draft with feedback
   */
  private async handleEditDraft(
    draft: EmailDraft,
    feedback: string,
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    try {
      if (onPartialResponse) {
        onPartialResponse(`✏️ Revising draft based on your feedback...\n\n`);
      }

      // Re-draft with feedback
      const revisionPrompt = `Revise this email draft based on the user's feedback.

Original request: "${draft.originalRequest}"
Current draft subject: ${draft.subject}
Current draft body:
${draft.body}

User feedback: "${feedback}"

Please revise the email accordingly. Maintain professional tone unless feedback specifically requests otherwise.

Format your response using XML tags:
<email>
  <subject>Your revised subject line here</subject>
  <body>Your revised email body here</body>
</email>`;

      const emailRevisionSystemPrompt = (await promptManager.getPrompt('PROMPT_EMAIL_REVISION'))?.content ||
        'You are Coach Artie, revising an email draft based on feedback.';
      const { messages } = await contextAlchemy.buildMessageChain(
        revisionPrompt,
        message.userId,
        emailRevisionSystemPrompt
      );

      const smartModel = openRouterService.selectSmartModel();
      const revisedDraft = await openRouterService.generateFromMessageChain(
        messages,
        message.userId,
        `${draft.id}_revision_${draft.version + 1}`,
        smartModel
      );

      // Parse the revised draft using XML parser
      const { subject, body } = this.parseEmailDraft(revisedDraft, draft.subject);

      draft.subject = subject;
      draft.body = body;
      draft.version += 1;
      draft.updatedAt = new Date();

      logger.info(`✏️ Revised draft ${draft.id} to version ${draft.version}`);

      return this.formatDraftDisplay(draft, `✏️ **Draft revised** (version ${draft.version})\n\n`);
    } catch (error) {
      logger.error('❌ Failed to revise draft:', error);
      return `❌ Failed to revise draft: ${error instanceof Error ? error.message : 'Unknown error'}\n\nOriginal draft is still available.`;
    }
  }

  /**
   * Parse email draft from XML response
   */
  private parseEmailDraft(
    response: string,
    fallbackSubject: string
  ): { subject: string; body: string } {
    try {
      // Use fast-xml-parser for proper XML parsing
      const { XMLParser } = require('fast-xml-parser');
      const parser = new XMLParser({
        ignoreAttributes: true,
        trimValues: true,
      });

      const parsed = parser.parse(response);

      if (parsed?.email?.subject && parsed?.email?.body) {
        return {
          subject: parsed.email.subject.trim(),
          body: parsed.email.body.trim(),
        };
      }

      // Fallback: treat entire response as body
      logger.warn('⚠️ No valid XML email structure found, using fallback');
      return {
        subject: fallbackSubject,
        body: response.trim(),
      };
    } catch (error) {
      logger.error('❌ Failed to parse email draft:', error);
      return {
        subject: fallbackSubject,
        body: response.trim(),
      };
    }
  }

  /**
   * Format draft for display to user
   */
  private formatDraftDisplay(draft: EmailDraft, prefix: string = ''): string {
    return `${prefix}**📧 Draft Email** (v${draft.version})

**To:** ${draft.to}
**Subject:** ${draft.subject}

${draft.body}

---

**What's next?** Reply with:
- **"send"** → Send this email now
- **"edit [feedback]"** → Revise based on your notes
  Examples: "edit make it shorter", "edit more formal", "edit add meeting time"
- **"cancel"** → Discard this draft`;
  }
}

export const emailDraftingService = EmailDraftingService.getInstance();
