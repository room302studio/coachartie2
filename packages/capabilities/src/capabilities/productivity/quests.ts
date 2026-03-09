/**
 * Quests Capability
 *
 * Track and guide users through complex multi-step real-world processes.
 * Inspired by Clawdbot's "quests" skill - helps users complete workflows
 * like onboarding, troubleshooting, learning paths, etc.
 *
 * PERSISTENCE: Quests are stored in Artie's memory system with tag "quest"
 * This means quests survive restarts and can be accessed across platforms.
 *
 * Usage:
 * - "start quest: set up my dev environment"
 * - "what's my next step?"
 * - "mark step complete"
 * - "show my active quests"
 */

import { logger, getSyncDb } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';

interface QuestStep {
  id: number;
  title: string;
  description: string;
  completed: boolean;
  completedAt?: string;
  notes?: string;
}

interface Quest {
  id: string;
  userId: string;
  title: string;
  description: string;
  steps: QuestStep[];
  currentStep: number;
  status: 'active' | 'completed' | 'abandoned';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface QuestParams {
  action: string;
  title?: string;
  description?: string;
  steps?: string[];
  questId?: string;
  stepNotes?: string;
  [key: string]: unknown;
}

// In-memory cache (backed by DB)
const questCache = new Map<string, Quest[]>();

/**
 * Load quests from database for a user
 */
function loadUserQuests(userId: string): Quest[] {
  // Check cache first
  if (questCache.has(userId)) {
    return questCache.get(userId)!;
  }

  try {
    const db = getSyncDb();
    const rows = db.all<{ id: number; content: string; metadata: string }>(
      `SELECT id, content, metadata FROM memories
       WHERE user_id = ? AND tags LIKE '%"quest"%'
       ORDER BY created_at DESC`,
      [userId]
    );

    const quests: Quest[] = [];
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata || '{}');
        if (metadata.quest) {
          quests.push(metadata.quest as Quest);
        }
      } catch {
        // Skip malformed entries
      }
    }

    questCache.set(userId, quests);
    return quests;
  } catch (error) {
    logger.error('Failed to load quests from DB:', error);
    return [];
  }
}

/**
 * Save a quest to the database
 */
function saveQuest(quest: Quest): void {
  try {
    const db = getSyncDb();
    const questSummary = `Quest: ${quest.title} (${quest.status})`;
    const metadata = JSON.stringify({ quest, type: 'quest' });
    const tags = JSON.stringify(['quest', quest.status, 'workflow']);

    // Check if quest already exists
    const existing = db.get<{ id: number }>(
      `SELECT id FROM memories WHERE user_id = ? AND metadata LIKE ?`,
      [quest.userId, `%"id":"${quest.id}"%`]
    );

    if (existing) {
      // Update existing
      db.run(
        `UPDATE memories SET content = ?, metadata = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [questSummary, metadata, tags, existing.id]
      );
    } else {
      // Insert new
      db.run(
        `INSERT INTO memories (user_id, content, metadata, tags, timestamp, importance)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [quest.userId, questSummary, metadata, tags, new Date().toISOString(), 7]
      );
    }

    // Update cache
    const userQuests = questCache.get(quest.userId) || [];
    const existingIdx = userQuests.findIndex(q => q.id === quest.id);
    if (existingIdx >= 0) {
      userQuests[existingIdx] = quest;
    } else {
      userQuests.push(quest);
    }
    questCache.set(quest.userId, userQuests);
  } catch (error) {
    logger.error('Failed to save quest:', error);
  }
}

/**
 * Delete a quest from the database
 */
function deleteQuest(quest: Quest): void {
  try {
    const db = getSyncDb();
    db.run(
      `DELETE FROM memories WHERE user_id = ? AND metadata LIKE ?`,
      [quest.userId, `%"id":"${quest.id}"%`]
    );

    // Update cache
    const userQuests = questCache.get(quest.userId) || [];
    const idx = userQuests.findIndex(q => q.id === quest.id);
    if (idx >= 0) {
      userQuests.splice(idx, 1);
      questCache.set(quest.userId, userQuests);
    }
  } catch (error) {
    logger.error('Failed to delete quest:', error);
  }
}

/**
 * Generate a quest from a goal using simple heuristics
 */
function generateQuestSteps(goal: string): QuestStep[] {
  const goalLower = goal.toLowerCase();

  // Common quest templates
  if (goalLower.includes('dev environment') || goalLower.includes('development setup')) {
    return [
      { id: 1, title: 'Install prerequisites', description: 'Install Node.js, Git, and your preferred code editor', completed: false },
      { id: 2, title: 'Clone the repository', description: 'git clone the project repo to your local machine', completed: false },
      { id: 3, title: 'Install dependencies', description: 'Run npm install or pnpm install', completed: false },
      { id: 4, title: 'Set up environment variables', description: 'Copy .env.example to .env and fill in values', completed: false },
      { id: 5, title: 'Run the project', description: 'Start the dev server and verify it works', completed: false },
      { id: 6, title: 'Make a test change', description: 'Edit something small and see it reflected', completed: false },
    ];
  }

  if (goalLower.includes('learn') || goalLower.includes('tutorial')) {
    return [
      { id: 1, title: 'Understand the basics', description: 'Read intro docs or watch overview video', completed: false },
      { id: 2, title: 'Set up your environment', description: 'Install necessary tools and create a practice project', completed: false },
      { id: 3, title: 'Follow a tutorial', description: 'Complete a guided tutorial or course', completed: false },
      { id: 4, title: 'Build something small', description: 'Create a mini-project to practice', completed: false },
      { id: 5, title: 'Review and reflect', description: 'Note what you learned and what to explore next', completed: false },
    ];
  }

  if (goalLower.includes('debug') || goalLower.includes('fix') || goalLower.includes('troubleshoot')) {
    return [
      { id: 1, title: 'Reproduce the issue', description: 'Confirm you can consistently trigger the bug', completed: false },
      { id: 2, title: 'Gather information', description: 'Check logs, error messages, and recent changes', completed: false },
      { id: 3, title: 'Isolate the cause', description: 'Narrow down which component/code is responsible', completed: false },
      { id: 4, title: 'Research solutions', description: 'Search docs, Stack Overflow, or ask for help', completed: false },
      { id: 5, title: 'Implement the fix', description: 'Make the code changes', completed: false },
      { id: 6, title: 'Verify the fix', description: 'Test that the bug is gone and nothing else broke', completed: false },
    ];
  }

  if (goalLower.includes('deploy') || goalLower.includes('release') || goalLower.includes('ship')) {
    return [
      { id: 1, title: 'Run tests', description: 'Ensure all tests pass', completed: false },
      { id: 2, title: 'Review changes', description: 'Check diff, update changelog if needed', completed: false },
      { id: 3, title: 'Build production artifacts', description: 'Create optimized production build', completed: false },
      { id: 4, title: 'Deploy to staging', description: 'Test in staging environment first', completed: false },
      { id: 5, title: 'Deploy to production', description: 'Push to production', completed: false },
      { id: 6, title: 'Verify deployment', description: 'Check health endpoints and monitor for errors', completed: false },
    ];
  }

  // Generic quest for unknown goals
  return [
    { id: 1, title: 'Define success criteria', description: 'What does "done" look like?', completed: false },
    { id: 2, title: 'Break it down', description: 'List the major milestones', completed: false },
    { id: 3, title: 'Start with the first step', description: 'Begin working on the initial task', completed: false },
    { id: 4, title: 'Check progress', description: 'Review what\'s done and what remains', completed: false },
    { id: 5, title: 'Complete and celebrate', description: 'Finish up and acknowledge the accomplishment', completed: false },
  ];
}

/**
 * Quest capability handler
 */
async function handleQuests(
  params: QuestParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'unknown-user';

  logger.info(`Quest handler - Action: ${action}, UserId: ${userId}`);

  // Load user's quests from DB
  const userQuests = loadUserQuests(userId);

  try {
    switch (action) {
      case 'start':
      case 'create': {
        const title = params.title || content;
        if (!title) {
          return 'Please provide a quest title or goal. Example: "start quest: learn TypeScript"';
        }

        const steps = params.steps
          ? params.steps.map((s, i) => ({ id: i + 1, title: s, description: s, completed: false }))
          : generateQuestSteps(title);

        const quest: Quest = {
          id: `quest-${Date.now()}`,
          userId,
          title,
          description: params.description || `Quest to: ${title}`,
          steps,
          currentStep: 0,
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        saveQuest(quest);

        const stepList = steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
        return `**Quest Started: ${title}**\n\nSteps:\n${stepList}\n\n**Next:** ${steps[0].title}\n${steps[0].description}`;
      }

      case 'next':
      case 'current':
      case 'status': {
        const activeQuest = userQuests.find(q => q.status === 'active');
        if (!activeQuest) {
          return 'No active quests. Start one with: "start quest: [your goal]"';
        }

        const currentStep = activeQuest.steps[activeQuest.currentStep];
        const progress = activeQuest.steps.filter(s => s.completed).length;
        const total = activeQuest.steps.length;
        const progressBar = '█'.repeat(progress) + '░'.repeat(total - progress);

        return `**${activeQuest.title}**\n\nProgress: [${progressBar}] ${progress}/${total}\n\n**Current Step ${activeQuest.currentStep + 1}:** ${currentStep.title}\n${currentStep.description}`;
      }

      case 'complete':
      case 'done':
      case 'finish': {
        const activeQuest = userQuests.find(q => q.status === 'active');
        if (!activeQuest) {
          return 'No active quest to mark progress on.';
        }

        const currentStep = activeQuest.steps[activeQuest.currentStep];
        currentStep.completed = true;
        currentStep.completedAt = new Date().toISOString();
        if (params.stepNotes) {
          currentStep.notes = params.stepNotes;
        }

        activeQuest.currentStep++;
        activeQuest.updatedAt = new Date().toISOString();

        // Check if quest is complete
        if (activeQuest.currentStep >= activeQuest.steps.length) {
          activeQuest.status = 'completed';
          activeQuest.completedAt = new Date().toISOString();
          saveQuest(activeQuest);
          return `**Quest Complete: ${activeQuest.title}!**\n\nAll ${activeQuest.steps.length} steps finished. Well done!`;
        }

        saveQuest(activeQuest);

        const nextStep = activeQuest.steps[activeQuest.currentStep];
        const progress = activeQuest.steps.filter(s => s.completed).length;
        const total = activeQuest.steps.length;

        return `Step completed: ${currentStep.title}\n\nProgress: ${progress}/${total}\n\n**Next:** ${nextStep.title}\n${nextStep.description}`;
      }

      case 'skip': {
        const activeQuest = userQuests.find(q => q.status === 'active');
        if (!activeQuest) {
          return 'No active quest.';
        }

        const skippedStep = activeQuest.steps[activeQuest.currentStep];
        activeQuest.currentStep++;
        activeQuest.updatedAt = new Date().toISOString();

        if (activeQuest.currentStep >= activeQuest.steps.length) {
          activeQuest.status = 'completed';
          activeQuest.completedAt = new Date().toISOString();
          saveQuest(activeQuest);
          return `Skipped: ${skippedStep.title}\n\nQuest complete (with skipped steps)!`;
        }

        saveQuest(activeQuest);

        const nextStep = activeQuest.steps[activeQuest.currentStep];
        return `Skipped: ${skippedStep.title}\n\n**Next:** ${nextStep.title}\n${nextStep.description}`;
      }

      case 'list': {
        if (userQuests.length === 0) {
          return 'No quests yet. Start one with: "start quest: [your goal]"';
        }

        const questList = userQuests.map(q => {
          const progress = q.steps.filter(s => s.completed).length;
          const emoji = q.status === 'completed' ? '✅' : q.status === 'abandoned' ? '❌' : '🗺️';
          return `${emoji} **${q.title}** - ${progress}/${q.steps.length} steps (${q.status})`;
        }).join('\n');

        return `**Your Quests:**\n\n${questList}`;
      }

      case 'abandon':
      case 'cancel': {
        const activeQuest = userQuests.find(q => q.status === 'active');
        if (!activeQuest) {
          return 'No active quest to abandon.';
        }

        activeQuest.status = 'abandoned';
        activeQuest.updatedAt = new Date().toISOString();
        saveQuest(activeQuest);

        return `Quest abandoned: ${activeQuest.title}`;
      }

      case 'resume': {
        // Find most recent abandoned or completed quest to resume
        const resumable = userQuests.find(q => q.status === 'abandoned' || q.status === 'completed');
        if (!resumable) {
          return 'No quest to resume.';
        }

        resumable.status = 'active';
        resumable.updatedAt = new Date().toISOString();
        saveQuest(resumable);

        const currentStep = resumable.steps[resumable.currentStep];
        return `Quest resumed: ${resumable.title}\n\n**Current Step:** ${currentStep?.title || 'Complete!'}`;
      }

      case 'clear': {
        // Clear all completed/abandoned quests
        const toDelete = userQuests.filter(q => q.status !== 'active');
        for (const quest of toDelete) {
          deleteQuest(quest);
        }
        return `Cleared ${toDelete.length} completed/abandoned quests.`;
      }

      default:
        return `Unknown quest action: ${action}. Try: start, next, complete, skip, list, abandon, resume, clear`;
    }
  } catch (error) {
    logger.error('Quest error:', error);
    return `Quest error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const questsCapability: RegisteredCapability = {
  name: 'quests',
  emoji: '🗺️',
  supportedActions: ['start', 'create', 'next', 'current', 'status', 'complete', 'done', 'finish', 'skip', 'list', 'abandon', 'cancel', 'resume', 'clear'],
  description: `Guide users through complex multi-step processes with structured quests. Quests persist across sessions. Actions:
- start/create: Begin a new quest with auto-generated steps (e.g., "start quest: learn TypeScript")
- next/current/status: Show current step and progress
- complete/done: Mark current step as finished
- skip: Skip current step and move to next
- list: Show all quests
- abandon: Give up on current quest
- resume: Resume an abandoned quest
- clear: Remove completed/abandoned quests

Quest templates exist for: dev setup, learning, debugging, deployment. Other goals get generic steps.`,
  handler: handleQuests,
};
