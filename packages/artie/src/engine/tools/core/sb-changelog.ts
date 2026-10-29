/**
 * sb_changelog: the real Subway Builder release notes (EJ, 2026-10-29). Asked for "the full list
 * of new features" in the Beta 1.7.27 thread, Artie had nothing to go on and invented
 * subwaybuilder.com/whatsnew (a 404). The canonical notes live in the game repo as
 * Subway-Builder/metro-maker4 shared-data/changelog.ts (beta branch for betas, main for public);
 * the website's changelog page renders that file but client-side, so a plain fetch can't read it.
 *
 * The file is TypeScript, so it's parsed with the TypeScript compiler's AST, never evaluated.
 */
import type { RegisteredCapability } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';

const REPO = 'Subway-Builder/metro-maker4';
const PATH = 'shared-data/changelog.ts';
const CACHE_MS = 15 * 60_000;
const SECTIONS: Array<{ label: string; type: string }> = [
  { label: 'Features', type: 'feature' },
  { label: 'Improvements', type: 'improvement' },
  { label: 'Bug fixes', type: 'bugfix' },
  { label: 'Modding changes', type: 'moddingchange' },
];

export interface ChangelogEntry {
  version: string;
  date: string;
  info?: string;
  changes: Array<{ type: string; description: string }>;
}

/** Parse changelog.ts source into entries without executing it. */
export async function parseChangelogSource(source: string): Promise<ChangelogEntry[]> {
  const ts = (await import('typescript')).default;
  const file = ts.createSourceFile('changelog.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const text = (node: import('typescript').Node | undefined): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return text(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = text(node.left);
      const r = text(node.right);
      return l !== undefined && r !== undefined ? l + r : undefined;
    }
    return undefined;
  };
  const prop = (obj: import('typescript').ObjectLiteralExpression, name: string) =>
    obj.properties.find(
      (p): p is import('typescript').PropertyAssignment =>
        ts.isPropertyAssignment(p) && ((ts.isIdentifier(p.name) && p.name.text === name) || (ts.isStringLiteral(p.name) && p.name.text === name))
    )?.initializer;

  let array: import('typescript').ArrayLiteralExpression | undefined;
  const visit = (node: import('typescript').Node) => {
    if (array) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'changelog' && node.initializer) {
      let init = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isArrayLiteralExpression(init)) array = init;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!array) return [];

  const entries: ChangelogEntry[] = [];
  for (const el of array.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    const version = text(prop(el, 'version'));
    if (!version) continue;
    const changesNode = prop(el, 'changes');
    const changes: ChangelogEntry['changes'] = [];
    if (changesNode && ts.isArrayLiteralExpression(changesNode)) {
      for (const c of changesNode.elements) {
        if (!ts.isObjectLiteralExpression(c)) continue;
        const description = text(prop(c, 'description'));
        if (description) changes.push({ type: text(prop(c, 'type')) ?? 'other', description });
      }
    }
    entries.push({ version, date: text(prop(el, 'date')) ?? '', info: text(prop(el, 'info')), changes });
  }
  return entries;
}

export function formatChangelogEntry(entry: ChangelogEntry, channel: 'beta' | 'public'): string {
  let out = `Subway Builder ${entry.version} (${channel}${entry.date ? `, ${entry.date}` : ''})`;
  if (entry.info) out += `\n${entry.info}`;
  for (const s of SECTIONS) {
    const items = entry.changes.filter((c) => c.type === s.type);
    if (items.length) out += `\n\n${s.label}:\n` + items.map((c) => `- ${c.description}`).join('\n');
  }
  const other = entry.changes.filter((c) => !SECTIONS.some((s) => s.type === c.type));
  if (other.length) out += `\n\nOther:\n` + other.map((c) => `- ${c.description}`).join('\n');
  return out;
}

const cache = new Map<string, { at: number; entries: ChangelogEntry[] }>();

async function load(ref: 'beta' | 'main'): Promise<ChangelogEntry[]> {
  const hit = cache.get(ref);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries;
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${ref}`, {
    headers: { Accept: 'application/vnd.github.raw', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'User-Agent': 'coachartie' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`changelog fetch (${ref}) failed: HTTP ${res.status}`);
  const entries = await parseChangelogSource(await res.text());
  cache.set(ref, { at: Date.now(), entries });
  return entries;
}

export const sbChangelogCapability: RegisteredCapability = {
  name: 'sb_changelog',
  emoji: '🚇',
  supportedActions: ['get'],
  description:
    "The real Subway Builder release notes, straight from the game's changelog (betas and public releases). " +
    "Use it for any what's-new, patch-notes or 'what changed in X' question.",
  examples: ['<capability name="sb_changelog" action="get" version="1.7.27" />', '<capability name="sb_changelog" action="get" />'],
  handler: async (params) => {
    const wanted = typeof params.version === 'string' ? params.version.trim().replace(/^v/i, '') : '';
    try {
      const beta = await load('beta');
      const pub = await load('main').catch(() => [] as ChangelogEntry[]);
      const publicVersions = new Set(pub.map((e) => e.version));
      if (wanted) {
        const entry = beta.find((e) => e.version === wanted) ?? pub.find((e) => e.version === wanted);
        if (!entry) {
          const recent = beta.slice(0, 5).map((e) => e.version).join(', ');
          return `No changelog entry for ${wanted}. Most recent versions: ${recent}.`;
        }
        return formatChangelogEntry(entry, publicVersions.has(entry.version) ? 'public' : 'beta');
      }
      const latest = beta[0] ?? pub[0];
      if (!latest) return 'The changelog is empty or unreadable right now.';
      const latestPublic = pub[0];
      let out = formatChangelogEntry(latest, publicVersions.has(latest.version) ? 'public' : 'beta');
      if (latestPublic && latestPublic.version !== latest.version) out += `\n\n(Latest public release: ${latestPublic.version}.)`;
      return out;
    } catch (error) {
      logger.warn('🚇 sb_changelog failed:', error);
      return "Couldn't read the Subway Builder changelog right now; don't guess, say you'll check.";
    }
  },
};
