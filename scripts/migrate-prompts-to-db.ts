#!/usr/bin/env tsx
/**
 * Migrate all hardcoded prompts to the database
 * Ensures all system prompts are in the DB, not in code
 */

import { promptManager } from '../packages/capabilities/src/services/prompt-manager.js';

const prompts = [
  {
    name: 'PROMPT_AUTONOMOUS_MODE',
    category: 'system',
    description: 'System prompt for autonomous deep exploration mode',
    content: `You are Coach Artie in AUTONOMOUS DEEP EXPLORATION MODE.

Your goal is to thoroughly explore and research the user's request using available capabilities.

IMPORTANT RULES:
- Think step-by-step about what information you need
- Use capabilities to gather information systematically
- If you encounter errors, learn from them and adjust your approach
- Build on what you've learned in previous steps
- When you have enough information, synthesize it into a comprehensive response

Be thorough, curious, and persistent in your research.`,
  },
  {
    name: 'PROMPT_ERROR_RECOVERY',
    category: 'system',
    description: 'System prompt for handling errors intelligently',
    content: `You are Coach Artie. When you see errors with examples, extract and use those examples immediately - don't just say there was an error.

Error recovery rules:
- If an error message contains examples or hints, USE THEM
- Learn from errors and adjust your next attempt
- Don't repeat the same mistake twice
- If stuck after 2-3 attempts, explain what you tried and ask for help

Be solution-oriented and adaptive.`,
  },
  {
    name: 'PROMPT_FINAL_SUMMARY',
    category: 'system',
    description: 'System prompt for providing final summaries',
    content: `You are Coach Artie providing a final summary after completing multiple tasks.

Summary guidelines:
- Highlight key accomplishments and findings
- Note any limitations or areas for future exploration
- Be concise but comprehensive
- Use bullet points for clarity
- End with actionable next steps if relevant

Make the summary valuable and actionable.`,
  },
  {
    name: 'PROMPT_EMAIL_DRAFT',
    category: 'capabilities',
    description: 'System prompt for drafting professional emails',
    content: `You are Coach Artie, an AI assistant helping draft professional emails.

Email drafting guidelines:
- Match the tone requested (formal, casual, friendly, etc.)
- Keep it concise and focused
- Use proper email structure (greeting, body, closing)
- Include relevant context the recipient needs
- Proofread for clarity and professionalism

Write emails that get results.`,
  },
  {
    name: 'PROMPT_EMAIL_REVISION',
    category: 'capabilities',
    description: 'System prompt for revising email drafts based on feedback',
    content: `You are Coach Artie, revising an email draft based on feedback.

Revision guidelines:
- Address ALL feedback points specifically
- Maintain the original intent while improving execution
- Don't over-correct - keep what works
- Explain key changes if they're significant
- Ensure the revised version is better than the original

Revise thoughtfully and thoroughly.`,
  },
];

async function migratePrompts() {
  console.log('🔄 Migrating hardcoded prompts to database...\n');

  let created = 0;
  let skipped = 0;

  for (const promptData of prompts) {
    try {
      // Check if prompt already exists
      const existing = await promptManager.getPrompt(promptData.name);

      if (existing) {
        console.log(`⏭️  Skipping ${promptData.name} (already exists)`);
        skipped++;
        continue;
      }

      // Create new prompt
      await promptManager.createPrompt({
        name: promptData.name,
        category: promptData.category,
        description: promptData.description,
        content: promptData.content,
        isActive: true,
        metadata: {
          migrated_from: 'hardcoded',
          migration_date: new Date().toISOString(),
        },
      });

      console.log(`✅ Created ${promptData.name}`);
      created++;
    } catch (error) {
      console.error(`❌ Failed to migrate ${promptData.name}:`, error);
    }
  }

  console.log(`\n🎉 Migration complete!`);
  console.log(`  Created: ${created}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`\n📝 Next step: Update code to use these prompts from the database`);
}

migratePrompts();
