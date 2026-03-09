import { logger, IncomingMessage } from '@coachartie/shared';
import { openRouterService } from '../llm/openrouter.js';
import { contextAlchemy } from '../llm/context-alchemy.js';
import { promptManager } from '../llm/prompt-manager.js';

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
   *
   * NOTE: Removed keyword heuristics - the LLM should handle email intent
   * through the normal capability system. This function now just returns null
   * to let the LLM decide.
   */
  async detectEmailIntent(
    _message: string,
    _userId?: string
  ): Promise<{ to: string; subject?: string; about?: string } | null> {
    // Don't try to guess email intent with keyword matching
    // Let the LLM handle this through capabilities
    return null;
  }

  /**
   * Extract email address from text given the @ position (no regex)
   */
  private extractEmailAddress(text: string, atIndex: number): string | null {
    // Find start of email (walk backwards from @)
    let start = atIndex;
    while (start > 0) {
      const char = text[start - 1];
      if (char === ' ' || char === '<' || char === '(' || char === '\n') break;
      start--;
    }

    // Find end of email (walk forwards from @)
    let end = atIndex;
    while (end < text.length) {
      const char = text[end];
      if (
        char === ' ' ||
        char === '>' ||
        char === ')' ||
        char === '\n' ||
        char === ',' ||
        char === ';'
      )
        break;
      end++;
    }

    const candidate = text.substring(start, end);

    // Basic validation: must have @ with text on both sides and a dot after @
    const parts = candidate.split('@');
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;
    if (!parts[1].includes('.')) return null;

    return candidate;
  }

  /**
   * Extract "about X" topic from message (no regex)
   */
  private extractAboutTopic(message: string): string | undefined {
    const lowerMessage = message.toLowerCase();
    const aboutIndex = lowerMessage.indexOf(' about ');
    if (aboutIndex === -1) return undefined;

    // Get text after "about "
    const afterAbout = message.substring(aboutIndex + 7);

    // Find first sentence-ending punctuation
    let endIndex = -1;
    for (let i = 0; i < afterAbout.length; i++) {
      const char = afterAbout[i];
      if (char === '.' || char === '!' || char === '?' || char === '\n') {
        endIndex = i;
        break;
      }
    }

    return endIndex === -1 ? afterAbout.trim() : afterAbout.substring(0, endIndex).trim();
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

      const emailDraftSystemPrompt =
        (await promptManager.getPrompt('PROMPT_EMAIL_DRAFT'))?.content ||
        'You are Coach Artie, helping draft professional emails.';
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
   *
   * NOTE: Removed regex heuristics - the LLM should interpret user intent
   * in context. If there's a pending draft, include that context in the
   * prompt and let the LLM decide what the user wants.
   */
  detectDraftResponse(
    _message: string
  ): { action: 'send' | 'edit' | 'cancel'; feedback?: string } | null {
    // Don't try to guess user intent with regex
    // Let the LLM handle this in context
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
        const { emailCapability } = await import('../../capabilities/communication/email.js');
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

      const emailRevisionSystemPrompt =
        (await promptManager.getPrompt('PROMPT_EMAIL_REVISION'))?.content ||
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
   * Parse email draft from XML response (simple string parsing, no regex)
   */
  private parseEmailDraft(
    response: string,
    fallbackSubject: string
  ): { subject: string; body: string } {
    try {
      // Simple XML tag extraction without regex
      const subjectStart = response.indexOf('<subject>');
      const subjectEnd = response.indexOf('</subject>');
      const bodyStart = response.indexOf('<body>');
      const bodyEnd = response.indexOf('</body>');

      if (subjectStart !== -1 && subjectEnd !== -1 && bodyStart !== -1 && bodyEnd !== -1) {
        const subject = response.substring(subjectStart + 9, subjectEnd).trim();
        const body = response.substring(bodyStart + 6, bodyEnd).trim();

        if (subject && body) {
          return { subject, body };
        }
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
