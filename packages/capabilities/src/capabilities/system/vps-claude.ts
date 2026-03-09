/**
 * VPS Claude Capability
 *
 * Gives Artie awareness of VPS Claude's state:
 * - Read briefing.md (auto-generated status)
 * - Read session notes
 * - See recent activity
 *
 * This creates cross-agent awareness - Artie knows what VPS Claude
 * has been doing and can reference that context in conversations.
 */

import { logger } from '@coachartie/shared';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';

const CLAUDE_HOME = '/home/debian/claude';
const BRIEFING_PATH = join(CLAUDE_HOME, 'briefing.md');
const NOTES_PATH = join(CLAUDE_HOME, 'notes');
const PROJECTS_PATH = join(CLAUDE_HOME, 'projects');

interface VPSClaudeParams {
  action: string;
  filename?: string;
  limit?: number;
  [key: string]: unknown;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function getRecentFiles(
  dir: string,
  limit: number = 5
): Array<{ name: string; modified: Date; preview: string }> {
  try {
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
      .map((f) => {
        const fullPath = join(dir, f);
        const stat = statSync(fullPath);
        const content = readFileSafe(fullPath) || '';
        return {
          name: f,
          modified: stat.mtime,
          preview:
            content.slice(0, 200).replace(/\n/g, ' ').trim() + (content.length > 200 ? '...' : ''),
        };
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, limit);

    return files;
  } catch {
    return [];
  }
}

async function handleVPSClaude(
  params: VPSClaudeParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;

  logger.info(`🤖 VPS-Claude handler - Action: ${action}`);

  try {
    switch (action) {
      case 'briefing': {
        // Read the auto-generated briefing
        const briefing = readFileSafe(BRIEFING_PATH);
        if (!briefing) {
          return JSON.stringify({
            success: false,
            error: 'Briefing not available',
            hint: 'VPS Claude briefing is generated every 2 hours',
          });
        }

        return JSON.stringify({
          success: true,
          content: briefing,
          note: "This is VPS Claude's auto-generated status briefing",
        });
      }

      case 'notes': {
        // List recent session notes
        const limit = params.limit || 5;
        const notes = getRecentFiles(NOTES_PATH, limit);

        return JSON.stringify({
          success: true,
          count: notes.length,
          notes: notes.map((n) => ({
            name: n.name,
            modified: n.modified.toISOString(),
            preview: n.preview,
          })),
        });
      }

      case 'read_note': {
        // Read a specific note
        const filename = params.filename || content;
        if (!filename) {
          return JSON.stringify({ success: false, error: 'filename required' });
        }

        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '');
        const notePath = join(NOTES_PATH, safeName);

        if (!existsSync(notePath)) {
          return JSON.stringify({ success: false, error: `Note not found: ${safeName}` });
        }

        const noteContent = readFileSafe(notePath);
        return JSON.stringify({
          success: true,
          filename: safeName,
          content: noteContent,
        });
      }

      case 'projects': {
        // List VPS Claude's project files
        const limit = params.limit || 10;
        const projects = getRecentFiles(PROJECTS_PATH, limit);

        return JSON.stringify({
          success: true,
          count: projects.length,
          projects: projects.map((p) => ({
            name: p.name,
            modified: p.modified.toISOString(),
            preview: p.preview,
          })),
        });
      }

      case 'status': {
        // Quick status summary
        const briefing = readFileSafe(BRIEFING_PATH);
        const recentNotes = getRecentFiles(NOTES_PATH, 3);
        const recentProjects = getRecentFiles(PROJECTS_PATH, 3);

        // Extract key info from briefing
        let briefingSummary = 'Briefing not available';
        if (briefing) {
          // Get first few lines as summary
          const lines = briefing
            .split('\n')
            .filter((l) => l.trim())
            .slice(0, 5);
          briefingSummary = lines.join('\n');
        }

        return JSON.stringify({
          success: true,
          briefingSummary,
          recentNotes: recentNotes.map((n) => n.name),
          recentProjects: recentProjects.map((p) => p.name),
          note: 'Use briefing/notes/projects actions for full details',
        });
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Available: briefing, notes, read_note, projects, status`,
        });
    }
  } catch (error) {
    logger.error(`❌ VPS-Claude error for action '${action}':`, error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const vpsClaudeCapability: RegisteredCapability = {
  name: 'vps_claude',
  emoji: '🤖',
  supportedActions: ['briefing', 'notes', 'read_note', 'projects', 'status'],
  description:
    "Access VPS Claude's state - briefings, session notes, and project docs. Enables cross-agent awareness.",
  handler: handleVPSClaude,
  examples: [
    '<capability name="vps_claude" action="status" /> - Quick overview of VPS Claude state',
    '<capability name="vps_claude" action="briefing" /> - Read full auto-generated briefing',
    '<capability name="vps_claude" action="notes" limit="5" /> - Recent session notes',
    '<capability name="vps_claude" action="read_note" filename="2024-01-15-session.md" />',
  ],
};

export default vpsClaudeCapability;
