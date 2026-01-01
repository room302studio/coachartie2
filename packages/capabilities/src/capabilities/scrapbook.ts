import { logger } from '@coachartie/shared';
import type { RegisteredCapability } from '../services/capability-registry.js';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Initialize Supabase client lazily
let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;

    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_KEY environment variables are required');
    }

    supabase = createClient(url, key);
  }
  return supabase;
}

// Select fields (exclude heavy embedding fields)
const SELECT_FIELDS =
  'scrap_id,id,created_at,source,type,content,url,title,tags,concept_tags,summary,relationships,location,content_type,shared';

interface Scrap {
  scrap_id: string;
  id: string;
  created_at: string;
  source: string;
  type: string;
  content: string;
  url: string;
  title: string;
  tags: string[];
  concept_tags: string[];
  summary: string;
  relationships: Array<{ source: string; target: string; relationship: string }>;
  location: string;
  content_type: string;
  shared: boolean;
}

function formatScrap(scrap: Scrap): string {
  const parts: string[] = [];

  // Date
  const date = new Date(scrap.created_at).toLocaleDateString();
  parts.push(`[${date}]`);

  // Type indicator
  const typeIcons: Record<string, string> = {
    article: 'article',
    bookmark: 'bookmark',
    video: 'video',
    image: 'image',
    news: 'news',
    repo: 'repo',
    status: 'status',
  };
  const type = scrap.content_type || scrap.type || scrap.source || 'item';
  parts.push(`(${typeIcons[type?.toLowerCase()] || type})`);

  // Title or content preview
  if (scrap.title && scrap.title !== '[no title]') {
    parts.push(scrap.title.substring(0, 100));
  } else if (scrap.content) {
    parts.push(scrap.content.substring(0, 100).replace(/\n/g, ' '));
  }

  // URL
  if (scrap.url) {
    parts.push(`\n  URL: ${scrap.url}`);
  }

  // Tags
  if (scrap.tags?.length > 0) {
    parts.push(`\n  Tags: ${scrap.tags.slice(0, 5).join(', ')}`);
  }

  // Summary (truncated)
  if (scrap.summary) {
    const cleanSummary = scrap.summary.replace(/\n/g, ' ').substring(0, 150);
    parts.push(`\n  Summary: ${cleanSummary}...`);
  }

  // Location
  if (scrap.location && scrap.location !== 'Unknown') {
    parts.push(`\n  Location: ${scrap.location}`);
  }

  // Public URL
  parts.push(`\n  View: https://ejfox.com/scrapbook/${scrap.scrap_id || scrap.id}`);

  return parts.join(' ');
}

async function searchScraps(query: string, limit: number = 10): Promise<string> {
  const client = getSupabase();

  const searchPattern = `%${query}%`;

  const { data, error } = await client
    .from('scraps')
    .select(SELECT_FIELDS)
    .or(
      `content.ilike.${searchPattern},summary.ilike.${searchPattern},title.ilike.${searchPattern}`
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Scrapbook search error: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return `No scraps found matching "${query}"`;
  }

  const results = data.map((scrap: Scrap, i: number) => `${i + 1}. ${formatScrap(scrap)}`);
  return `Found ${data.length} scraps matching "${query}":\n\n${results.join('\n\n')}`;
}

async function getRecentScraps(limit: number = 10, source?: string): Promise<string> {
  const client = getSupabase();

  let queryBuilder = client
    .from('scraps')
    .select(SELECT_FIELDS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (source) {
    queryBuilder = queryBuilder.eq('source', source);
  }

  const { data, error } = await queryBuilder;

  if (error) {
    throw new Error(`Scrapbook fetch error: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return 'No recent scraps found';
  }

  const results = data.map((scrap: Scrap, i: number) => `${i + 1}. ${formatScrap(scrap)}`);
  const sourceStr = source ? ` from ${source}` : '';
  return `${data.length} most recent scraps${sourceStr}:\n\n${results.join('\n\n')}`;
}

async function getScrapById(scrapId: string): Promise<string> {
  const client = getSupabase();

  const { data, error } = await client.from('scraps').select('*').eq('scrap_id', scrapId).single();

  if (error) {
    throw new Error(`Scrapbook fetch error: ${error.message}`);
  }

  if (!data) {
    return `No scrap found with ID: ${scrapId}`;
  }

  // Format full details
  const parts: string[] = [`Scrap Details (${scrapId}):`];

  if (data.title) parts.push(`Title: ${data.title}`);
  parts.push(`Created: ${new Date(data.created_at).toLocaleString()}`);
  if (data.source) parts.push(`Source: ${data.source}`);
  if (data.content_type) parts.push(`Type: ${data.content_type}`);
  if (data.url) parts.push(`URL: ${data.url}`);
  if (data.location && data.location !== 'Unknown') parts.push(`Location: ${data.location}`);

  if (data.content) {
    parts.push(
      `\nContent:\n${data.content.substring(0, 500)}${data.content.length > 500 ? '...' : ''}`
    );
  }

  if (data.summary) {
    parts.push(`\nSummary:\n${data.summary}`);
  }

  if (data.tags?.length > 0) {
    parts.push(`\nTags: ${data.tags.join(', ')}`);
  }

  if (data.concept_tags?.length > 0) {
    parts.push(`Concept Tags: ${data.concept_tags.join(', ')}`);
  }

  if (data.relationships?.length > 0) {
    const rels = data.relationships
      .slice(0, 10)
      .map(
        (r: { source: string; target: string; relationship: string }) =>
          `  ${r.source} ${r.relationship} ${r.target}`
      );
    parts.push(`\nRelationships:\n${rels.join('\n')}`);
  }

  parts.push(`\nPublic URL: https://ejfox.com/scrapbook/${data.scrap_id || data.id}`);

  return parts.join('\n');
}

async function queryByEntity(entityName: string, limit: number = 20): Promise<string> {
  const client = getSupabase();

  // First, fetch all scraps with relationships
  const { data, error } = await client
    .from('scraps')
    .select(SELECT_FIELDS)
    .not('relationships', 'is', null);

  if (error) {
    throw new Error(`Scrapbook entity query error: ${error.message}`);
  }

  if (!data) {
    return `No scraps found with relationships`;
  }

  // Filter scraps that mention the entity
  const normalizedQuery = entityName.toLowerCase().trim();

  const matchingScraps = data.filter((scrap: Scrap) => {
    if (!scrap.relationships || !Array.isArray(scrap.relationships)) return false;

    return scrap.relationships.some((rel) => {
      const source = String(rel.source || '')
        .toLowerCase()
        .trim();
      const target = String(rel.target || '')
        .toLowerCase()
        .trim();

      return source.includes(normalizedQuery) || target.includes(normalizedQuery);
    });
  });

  if (matchingScraps.length === 0) {
    return `No scraps found mentioning entity "${entityName}"`;
  }

  // Build connection summary
  const connections: Record<string, { count: number; relationship: string }> = {};

  matchingScraps.forEach((scrap: Scrap) => {
    scrap.relationships?.forEach((rel) => {
      const source = String(rel.source || '').toLowerCase();
      const target = String(rel.target || '').toLowerCase();
      const isSource = source.includes(normalizedQuery);
      const connectedEntity = isSource ? rel.target : rel.source;

      if (connectedEntity) {
        const key = connectedEntity;
        if (!connections[key]) {
          connections[key] = { count: 0, relationship: rel.relationship || 'RELATED_TO' };
        }
        connections[key].count++;
      }
    });
  });

  // Sort by count
  const sortedConnections = Object.entries(connections)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);

  const results: string[] = [
    `Entity Graph for "${entityName}":`,
    `Found ${matchingScraps.length} scraps mentioning this entity.`,
    `\nConnected Entities (${sortedConnections.length}):`,
  ];

  sortedConnections.forEach(([entity, info], i) => {
    results.push(`  ${i + 1}. ${entity} (${info.relationship}, ${info.count} mentions)`);
  });

  // Show sample scraps
  results.push(`\nSample Scraps:`);
  matchingScraps.slice(0, Math.min(5, limit)).forEach((scrap: Scrap, i: number) => {
    results.push(`  ${i + 1}. ${formatScrap(scrap)}`);
  });

  return results.join('\n');
}

async function getStats(): Promise<string> {
  const client = getSupabase();

  // Get total count
  const { count, error: countError } = await client
    .from('scraps')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    throw new Error(`Scrapbook stats error: ${countError.message}`);
  }

  // Get source breakdown
  const { data: sources, error: sourceError } = await client.from('scraps').select('source');

  if (sourceError) {
    throw new Error(`Scrapbook stats error: ${sourceError.message}`);
  }

  const sourceCounts: Record<string, number> = {};
  sources?.forEach((s: { source: string }) => {
    const src = s.source || 'unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  });

  const sortedSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `  ${source}: ${count}`);

  return [`Scrapbook Statistics:`, `Total Scraps: ${count}`, `\nBy Source:`, ...sortedSources].join(
    '\n'
  );
}

export const scrapbookCapability: RegisteredCapability = {
  name: 'scrapbook',
  emoji: '📚',
  supportedActions: ['search', 'recent', 'get', 'entity', 'stats'],
  description:
    "Query EJ's scrapbook - a personal knowledge base of bookmarks, articles, notes, and web content with rich metadata",
  requiredParams: [],
  examples: [
    '<scrapbook-search>machine learning</scrapbook-search>',
    '<scrapbook-recent limit="5" />',
    '<scrapbook-get>abc123</scrapbook-get>',
    '<scrapbook-entity>OpenAI</scrapbook-entity>',
    '<scrapbook-stats />',
  ],

  handler: async (params, content) => {
    const { action, query, limit = 10, id, entity, source } = params;

    logger.info(`Scrapbook capability: action=${action}, query=${query || content}`);

    try {
      switch (action) {
        case 'search':
          const searchQuery = query || content;
          if (!searchQuery) {
            return 'Please provide a search query. Example: <capability name="scrapbook" action="search" data=\'{"query":"visualization"}\' />';
          }
          return await searchScraps(searchQuery, limit);

        case 'recent':
          return await getRecentScraps(limit, source);

        case 'get':
          const scrapId = id || content;
          if (!scrapId) {
            return 'Please provide a scrap ID. Example: <capability name="scrapbook" action="get" data=\'{"id":"abc123"}\' />';
          }
          return await getScrapById(scrapId);

        case 'entity':
          const entityName = entity || content;
          if (!entityName) {
            return 'Please provide an entity name. Example: <capability name="scrapbook" action="entity" data=\'{"entity":"GPT"}\' />';
          }
          return await queryByEntity(entityName, limit);

        case 'stats':
          return await getStats();

        default:
          return `Unknown action: ${action}. Supported actions: search, recent, get, entity, stats`;
      }
    } catch (error) {
      logger.error('Scrapbook capability error:', error);
      return `Scrapbook error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
