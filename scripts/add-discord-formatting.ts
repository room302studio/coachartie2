#!/usr/bin/env tsx
/**
 * Add Discord formatting guidelines to capability_instructions prompt
 * Fixes issues like the Wikimedia template formatting problem
 */

import { promptManager } from '../packages/capabilities/src/services/prompt-manager.js';

async function addDiscordFormatting() {
  try {
    console.log('📝 Adding Discord formatting guidelines to capability_instructions...\n');

    const current = await promptManager.getPrompt('capability_instructions');

    if (!current) {
      console.error('❌ Could not find capability_instructions prompt');
      process.exit(1);
    }

    // Add Discord formatting section to the prompt
    const updatedContent = `${current.content}

## Discord Formatting Guidelines

When responding in Discord, follow these formatting rules:

**Code Blocks:**
- Always use triple backticks with language hint: \`\`\`language
- NEVER let code blocks run together - put blank line before closing \`\`\`
- Example:
\`\`\`javascript
const example = "proper formatting";
\`\`\`

**Common Pitfalls to Avoid:**
❌ DON'T let template/code content touch the closing \`\`\`
❌ DON'T omit the language hint (use \`\`\`python, \`\`\`javascript, etc.)
❌ DON'T put comments after closing \`\`\`

✅ DO add a blank line before closing \`\`\`
✅ DO specify the language for syntax highlighting
✅ DO test complex templates before sending

**Lists:**
- Use * or - for bullet points
- Use 1. 2. 3. for numbered lists
- Add blank line between list and next paragraph

**Bold/Italic:**
- **Bold** with double asterisks
- *Italic* with single asterisks
- ***Bold italic*** with triple asterisks

**Links:**
- [Link text](URL)
- Discord auto-links URLs without markdown

User's message: {{USER_MESSAGE}}`;

    await promptManager.updatePrompt(
      'capability_instructions',
      updatedContent,
      'claude-code',
      'Added Discord formatting guidelines to prevent code block issues'
    );

    console.log('✅ Successfully updated capability_instructions');
    console.log(
      '📝 New version:',
      (await promptManager.getPrompt('capability_instructions'))?.version
    );
    console.log('\n🎉 Discord formatting guidelines added!');
    console.log('\nKey improvements:');
    console.log('  - Code block formatting rules');
    console.log('  - Common pitfalls to avoid');
    console.log('  - Proper markdown syntax');
  } catch (error) {
    console.error('❌ Failed to update prompt:', error);
    process.exit(1);
  }
}

addDiscordFormatting();
