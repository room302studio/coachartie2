// @ts-nocheck
/* eslint-disable */
/**
 * VENDORED COPY of @scrapbook/schema (packages/schema/index.js).
 * Source: ejfox/scrapbook-core (private) @ fe7ee46 (branch outputs, on origin/main 8dc4559; cleanTitle fix, 2026-11-24).
 * Vendored as .ts (with @ts-nocheck) because packages/artie has no allowJs; the body is byte-identical JS.
 * Do not edit below the marker; re-copy and update this header instead.
 * Check: node scripts/check-scrap-schema-drift.mjs
 * Why vendored: the monorepo is private and this repo's deploy cannot install it.
 */
// ---- VENDORED-BODY ----
/**
 * @scrapbook/schema
 *
 * The one place that knows what a row of the Supabase `scraps` table looks like
 * and what the conventions layered on top of it mean. Plain ESM, zero runtime
 * dependencies (node:crypto only). Every consumer (pipeline, CLI, Electron,
 * website2, coachartie, foxradiohour, scrapworld docs) should import from here
 * instead of carrying its own copy.
 *
 * Column types come from the DDL in apps/pipeline/migrations/00_init_scraps_recovery.sql
 * and apps/pipeline/supabase/migrations/20260729000000_add_screenshot_quality.sql.
 * Columns marked `observed: true` are not in any committed migration but are
 * written by pipeline code and so exist in the live table.
 */

import { createHash } from 'node:crypto'

/* ------------------------------------------------------------------------ */
/* Columns                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {'uuid'|'text'|'text[]'|'jsonb'|'boolean'|'double precision'|'real'|'int2'|'timestamptz'} PgType
 *
 * @typedef {object} ColumnMeta
 * @property {string} name
 * @property {PgType} type        Postgres type as declared in the migrations
 * @property {string} [js]        JS shape a reader should expect (`string[]`, `object`, ...)
 * @property {boolean} [required]
 * @property {*} [default]
 * @property {boolean} [ai]       filled by the enrichment pass, not by ingestion
 * @property {boolean} [embedding] large vector payload; never select by default
 * @property {boolean} [internal] pipeline bookkeeping; no consumer should read it
 * @property {boolean} [observed] no migration declares it; seen in writers
 * @property {string} description
 */

/** @type {ColumnMeta[]} */
export const SCRAP_FIELDS = [
  // Identity
  { name: 'id', type: 'uuid', required: true, description: 'Primary key. website2 permalinks use this, not scrap_id.' },
  { name: 'scrap_id', type: 'text', required: true, description: 'UNIQUE. "<source>-<source key>", see makeScrapId(). Upsert conflict key.' },
  { name: 'source', type: 'text', required: true, description: 'pinboard | arena | github | mastodon (+ sentinels: lock, system)' },
  { name: 'type', type: 'text', description: 'bookmark | block | repo | status | ...' },

  // Content
  { name: 'url', type: 'text', description: 'Canonical URL. Null on dead rows.' },
  { name: 'title', type: 'text', description: 'May hold the placeholders in TITLE_PLACEHOLDERS; use cleanTitle().' },
  { name: 'content', type: 'text', description: 'Extracted body text' },
  { name: 'summary', type: 'text', ai: true, description: 'AI summary (the field everyone reads)' },
  { name: 'meta_summary', type: 'text', ai: true, description: '~140 char synthesis for previews (scrapworld only)' },

  // Categorisation
  { name: 'tags', type: 'jsonb', js: 'string[]', default: [], description: 'User tags from the source. jsonb array of strings; "!"-prefixed = private control tag. Use parseTags()/publicTags().' },
  { name: 'concept_tags', type: 'text[]', js: 'string[]', ai: true, description: 'AI concept tags. NOTE text[], not jsonb: PostgREST array operators differ from `tags`.' },
  { name: 'relationships', type: 'jsonb', js: 'object[]', ai: true, description: 'Normalised typed relationships (graph edges)' },
  { name: 'relationships_raw', type: 'jsonb', js: 'object', ai: true, description: 'Pre-normalisation model output; scrapworld reads this' },
  { name: 'graph_imported', type: 'boolean', default: false, internal: true, description: 'Graph projection bookkeeping' },

  // Location
  { name: 'location', type: 'text', ai: true, description: 'Named place' },
  { name: 'latitude', type: 'double precision', js: 'number', ai: true, description: '' },
  { name: 'longitude', type: 'double precision', js: 'number', ai: true, description: '' },

  // AI extractions
  { name: 'financial_analysis', type: 'jsonb', js: 'object', ai: true, description: 'Sparse (~3 rows); CLI only' },
  { name: 'extraction_confidence', type: 'jsonb', js: 'object', ai: true, description: 'Per-field confidence object, NOT a number' },

  // Media
  { name: 'screenshot_url', type: 'text', ai: true, description: 'Cloudinary URL' },
  { name: 'content_type', type: 'text', description: 'article | video | ...' },

  // Metadata / visibility
  { name: 'metadata', type: 'jsonb', js: 'object', default: {}, description: 'Source-specific raw metadata (pinboard href/toread, content_extraction, ...)' },
  { name: 'shared', type: 'boolean', default: false, description: 'The only privacy gate. Public consumers MUST filter shared = true.' },
  { name: 'published_at', type: 'timestamptz', description: 'Original publication time' },
  { name: 'created_at', type: 'timestamptz', required: true, default: 'now()', description: '' },
  { name: 'updated_at', type: 'timestamptz', required: true, default: 'now()', description: '' },

  // Processing locks / bookkeeping
  { name: 'processing_instance_id', type: 'text', internal: true, description: 'Claim lock owner' },
  { name: 'processing_started_at', type: 'timestamptz', internal: true, description: 'Claim lock time' },
  { name: 'processing_meta', type: 'jsonb', js: 'object', internal: true, observed: true, description: 'Written by the pipeline; no migration declares it' },

  // Embeddings (jsonb placeholders, ENABLE_EMBEDDINGS gated). ~13 MB of a 17 MB 500-row pull.
  { name: 'embedding', type: 'jsonb', js: 'number[]', embedding: true, description: 'OpenAI text embedding' },
  { name: 'embedding_nomic', type: 'jsonb', js: 'number[]', embedding: true, description: 'Nomic text embedding' },
  { name: 'image_embedding', type: 'jsonb', js: 'number[]', embedding: true, description: 'Screenshot embedding' },

  // Screenshot quality gate (20260729 migration)
  { name: 'capture_status', type: 'int2', js: 'number', description: 'HTTP status at capture' },
  { name: 'screenshot_quality', type: 'text', description: 'accept | reject | review | recapture_pending. Unity filter: accept OR NULL' },
  { name: 'quality_category', type: 'text', description: 'content | login_wall | captcha | error_page | cookie_wall | blank | css_broken | unknown' },
  { name: 'quality_score', type: 'real', js: 'number', description: '0..1' },
  { name: 'quality_signals', type: 'jsonb', js: 'object', internal: true, description: '{aspect, dominantPct, entropy, visionConfidence, domain, recaptures}' },
  { name: 'quality_checked_at', type: 'timestamptz', internal: true, description: '' },
  { name: 'hide_shot_in_unity', type: 'boolean', default: false, description: 'reject => render a text card, keep the scrap' },
]

export const ALL_COLUMNS = SCRAP_FIELDS.map((f) => f.name)
export const REQUIRED_FIELDS = SCRAP_FIELDS.filter((f) => f.required).map((f) => f.name)
export const AI_EXTRACTED_FIELDS = SCRAP_FIELDS.filter((f) => f.ai).map((f) => f.name)
export const EMBEDDING_COLUMNS = SCRAP_FIELDS.filter((f) => f.embedding).map((f) => f.name)
export const INTERNAL_COLUMNS = SCRAP_FIELDS.filter((f) => f.internal).map((f) => f.name)

/**
 * What a public reader (website, bot, CLI list) should select: everything
 * except embeddings and pipeline bookkeeping. Matches website2's scraps.get.ts
 * list plus the columns scrapworld reads.
 */
export const PUBLIC_COLUMNS = SCRAP_FIELDS
  .filter((f) => !f.embedding && !f.internal)
  .map((f) => f.name)

/** The slim list every consumer reads (title/url/summary/tags/created_at/source + ids). */
export const CORE_COLUMNS = [
  'id', 'scrap_id', 'source', 'type', 'url', 'title', 'summary', 'tags', 'concept_tags',
  'content_type', 'screenshot_url', 'shared', 'published_at', 'created_at', 'updated_at',
]

/** PostgREST select string for a column list. */
export function selectList(columns = PUBLIC_COLUMNS) {
  return columns.join(',')
}

export function getFieldMeta(name) {
  return SCRAP_FIELDS.find((f) => f.name === name)
}

export function getFieldNames() {
  return ALL_COLUMNS.slice()
}

export function isAIField(name) {
  return AI_EXTRACTED_FIELDS.includes(name)
}

/* ------------------------------------------------------------------------ */
/* scrap_id                                                                  */
/* ------------------------------------------------------------------------ */

export const SOURCES = ['pinboard', 'arena', 'github', 'mastodon']

/**
 * scrap_id formats actually present in the table (read from the writers):
 *   pinboard-<pinboard hash>        apps/pipeline/scripts/index.mjs, dl_pinboard.mjs
 *   mastodon-<status id>            index.mjs, dl_mastodon.mjs
 *   github-<event/item id>          index.mjs, dl_github.mjs
 *   arena-<block id>                index.mjs (dl_arena.mjs wrongly uses a random UUID)
 *   youtube-watchlater-<md5(url)>   apps/cli/import-youtube-watchlater.js
 * The pinboard hash is Pinboard's own 32-hex bookmark hash; it is not computed here.
 */
export function makeScrapId(source, key) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('makeScrapId: source required')
  if (key === undefined || key === null || String(key).trim() === '') throw new TypeError('makeScrapId: key required')
  return `${source.trim().toLowerCase()}-${String(key).trim()}`
}

export const pinboardScrapId = (hash) => makeScrapId('pinboard', hash)
export const mastodonScrapId = (statusId) => makeScrapId('mastodon', statusId)
export const githubScrapId = (itemId) => makeScrapId('github', itemId)
export const arenaScrapId = (blockId) => makeScrapId('arena', blockId)

export function youtubeWatchLaterScrapId(url) {
  const cleaned = normalizeUrl(url)
  return makeScrapId('youtube-watchlater', createHash('md5').update(cleaned).digest('hex'))
}

/**
 * Split "<source>-<key>" back into its parts. Known multi-word prefixes
 * (youtube-watchlater) are handled; otherwise the first dash separates.
 * @returns {{source: string, key: string} | null}
 */
export function parseScrapId(scrapId) {
  if (typeof scrapId !== 'string' || !scrapId) return null
  if (scrapId.startsWith('youtube-watchlater-')) {
    return { source: 'youtube-watchlater', key: scrapId.slice('youtube-watchlater-'.length) }
  }
  const i = scrapId.indexOf('-')
  if (i <= 0 || i === scrapId.length - 1) return null
  return { source: scrapId.slice(0, i), key: scrapId.slice(i + 1) }
}

/* ------------------------------------------------------------------------ */
/* Sentinel rows                                                             */
/* ------------------------------------------------------------------------ */

export const SENTINEL_SOURCES = ['lock', 'system']
export const SENTINEL_SCRAP_IDS = ['init-test']

/**
 * Rows the pipeline inserts for its own bookkeeping (`__run_lock__` from
 * distributedLock.mjs, `init-test` with source 'lock' from index.mjs). They are
 * not scraps and must never reach a reader.
 */
export function isSentinel(scrap) {
  if (!scrap) return false
  let id = scrap
  if (typeof scrap === 'object') id = scrap.scrap_id
  if (typeof id === 'string' && (id.startsWith('__') || SENTINEL_SCRAP_IDS.includes(id))) return true
  if (typeof scrap === 'object' && SENTINEL_SOURCES.includes(scrap.source)) return true
  return false
}

/* ------------------------------------------------------------------------ */
/* Tags                                                                      */
/* ------------------------------------------------------------------------ */

export const CONTROL_TAG_PREFIX = '!'
export const HIDE_TAG = '!hide'

/**
 * `tags` is jsonb and should be an array, but it has been seen as a JSON
 * string (Electron's SQLite mirror stores TEXT), a space/comma separated
 * string (Pinboard API shape) and null. Always returns a clean string[].
 */
export function parseTags(value) {
  if (value === null || value === undefined) return []
  let arr = value
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s) return []
    if (s.startsWith('[')) {
      try { arr = JSON.parse(s) } catch { arr = s.split(/[,\s]+/) }
    } else {
      arr = s.split(/[,\s]+/)
    }
  }
  if (!Array.isArray(arr)) return []
  const out = []
  for (const t of arr) {
    if (typeof t !== 'string') continue
    const v = t.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** `!`-prefixed tags (`!hide`, `!tobuy`, ...) are private control tags; never show them. */
export function isControlTag(tag) {
  return typeof tag === 'string' && tag.startsWith(CONTROL_TAG_PREFIX)
}

export function publicTags(tags) {
  return parseTags(tags).filter((t) => !isControlTag(t))
}

export function controlTags(tags) {
  return parseTags(tags).filter(isControlTag)
}

/** scrap_doctor_ai prepends `!hide` to broken rows; readers must drop them. */
export function isHidden(scrap) {
  let tags = scrap
  if (scrap && typeof scrap === 'object' && !Array.isArray(scrap)) tags = scrap.tags
  return parseTags(tags).includes(HIDE_TAG)
}

/* ------------------------------------------------------------------------ */
/* Titles                                                                    */
/* ------------------------------------------------------------------------ */

/** Placeholders different writers have used for "no title". */
export const TITLE_PLACEHOLDERS = ['[no title]', '[No content available]', '(untitled scrap)']

/** Prefixes LLM summarisers leak into titles (website2 by-tags/temporal-context). */
export const AI_TITLE_PREFIXES = [
  'Main Thesis:',
  'Breaking News:',
  'Summary:',
  'The article ',
  '**Summary',
  '• ',
]

export function isPlaceholderTitle(title) {
  if (typeof title !== 'string') return true
  const t = title.trim()
  return !t || TITLE_PLACEHOLDERS.some((p) => p.toLowerCase() === t.toLowerCase())
}

/**
 * Strip AI preambles and markdown emphasis, collapse whitespace, and return
 * '' for placeholders so callers can fall back (see displayTitle).
 */
export function cleanTitle(title) {
  if (isPlaceholderTitle(title)) return ''
  let t = title.trim()
  let removedPrefix = false
  let changed = true
  while (changed) {
    changed = false
    // balanced emphasis around the whole title: **Title**, *Title*, __Title__, _Title_
    const unwrapped = t.replace(/^(\*\*|__|\*|_)(.+)\1$/, '$2').trim()
    if (unwrapped !== t) {
      t = unwrapped
      changed = true
    }
    for (const p of AI_TITLE_PREFIXES) {
      if (t.startsWith(p)) {
        t = t.slice(p.length).trim()
        removedPrefix = true
        changed = true
      }
    }
    // leftovers from a stripped prefix: "**Summary:** Foo" -> ":** Foo"
    // only after an AI prefix was removed: '-5°C forecast' must keep its minus sign
    let stripped = t
    if (removedPrefix) stripped = t.replace(/^[\s:*•·-]+/, '')
    if (stripped !== t) {
      t = stripped
      changed = true
    }
  }
  t = t.replace(/^\*\*(.+?)\*\*$/, '$1').replace(/\s+/g, ' ').trim()
  if (isPlaceholderTitle(t)) return ''
  return t
}

/** Hostname without a leading www., or '' for unparseable input. */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The fallback chain every consumer re-implements: cleaned title, first line
 * of the summary, hostname, then '(untitled scrap)'.
 */
export function displayTitle(scrap, { maxLength = 120 } = {}) {
  if (!scrap) return '(untitled scrap)'
  let t = cleanTitle(scrap.title)
  if (!t && typeof scrap.summary === 'string') {
    t = scrap.summary.split('\n').map((l) => l.trim()).find(Boolean) || ''
  }
  if (!t) t = hostnameOf(scrap.url)
  if (!t) t = '(untitled scrap)'
  if (t.length > maxLength) t = t.slice(0, maxLength - 1).trimEnd() + '…'
  return t
}

/* ------------------------------------------------------------------------ */
/* URLs                                                                      */
/* ------------------------------------------------------------------------ */

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si)$/i

/**
 * Normalise a URL for comparison/dedupe: https where possible, lowercase host,
 * no www., no tracking params, no fragment, no trailing slash on paths.
 * YouTube URLs collapse to https://youtube.com/watch?v=<id> (the CLI's cleanUrl).
 * Returns the trimmed input when it does not parse.
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string') return ''
  const raw = input.trim()
  if (!raw) return ''
  let u
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw
  u.protocol = 'https:'
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  u.hash = ''

  const host = u.hostname
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    // searchParams.get() already decodes; decode the youtu.be path segment once too,
    // then re-encode through URLSearchParams so the result is idempotent.
    let id = u.searchParams.get('v')
    if (host === 'youtu.be') {
      const segment = u.pathname.slice(1).split('/')[0]
      try {
        id = decodeURIComponent(segment)
      } catch {
        id = segment
      }
    }
    if (id) {
      const out = new URL('https://youtube.com/watch')
      out.searchParams.set('v', id)
      return out.toString()
    }
  }

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key)
  }
  u.searchParams.sort()
  let out = u.toString()
  if (u.pathname.length > 1 && u.pathname.endsWith('/') && !u.search) out = out.replace(/\/$/, '')
  return out
}

/* ------------------------------------------------------------------------ */
/* Visibility                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Is this row a real, showable scrap? shared=true, not a sentinel, not
 * `!hide`, has a URL and not just a placeholder title. This is the
 * `public_scraps` view in JS; website2/coachartie/scrapworld all approximate it.
 */
export function isPublicScrap(scrap) {
  if (!scrap || typeof scrap !== 'object') return false
  if (scrap.shared !== true) return false
  if (isSentinel(scrap)) return false
  if (isHidden(scrap)) return false
  if (!scrap.url) return false
  if (isPlaceholderTitle(scrap.title) && !scrap.summary) return false
  return true
}

/** Like isPublicScrap but without the `shared` gate, for private readers (CLI, indexer). */
export function isUsableScrap(scrap) {
  if (!scrap || typeof scrap !== 'object') return false
  if (isSentinel(scrap) || isHidden(scrap)) return false
  return true
}

/** website2 keys scrap pages by the UUID `id`: https://ejfox.com/scraps/<id>. */
export const SITE_ORIGIN = 'https://ejfox.com'
export function permalink(scrap) {
  let id = scrap
  if (scrap && typeof scrap === 'object') id = scrap.id
  if (!id || typeof id !== 'string') return null
  return `${SITE_ORIGIN}/scraps/${id}`
}

/* ------------------------------------------------------------------------ */
/* Row helpers (legacy lib/scrap-schema.js surface)                          */
/* ------------------------------------------------------------------------ */

export function createEmptyScrap(overrides = {}) {
  const scrap = {}
  for (const f of SCRAP_FIELDS) {
    scrap[f.name] = null
    if (f.default !== undefined && f.default !== 'now()') scrap[f.name] = structuredClone(f.default)
  }
  return { ...scrap, ...overrides }
}

export function validateScrap(scrap) {
  const errors = []
  for (const name of REQUIRED_FIELDS) {
    if (scrap?.[name] === undefined || scrap?.[name] === null || scrap?.[name] === '') {
      errors.push(`Missing required field: ${name}`)
    }
  }
  if (scrap?.tags !== undefined && scrap?.tags !== null && !Array.isArray(scrap.tags)) {
    errors.push('tags must be a JSON array')
  }
  return { valid: errors.length === 0, errors }
}

export function calculateCompleteness(scrap) {
  const filled = AI_EXTRACTED_FIELDS.filter((name) => {
    const v = scrap?.[name]
    if (Array.isArray(v)) return v.length > 0
    return v !== null && v !== undefined && v !== ''
  }).length
  return Math.round((filled / AI_EXTRACTED_FIELDS.length) * 100)
}

export default {
  SCRAP_FIELDS, ALL_COLUMNS, REQUIRED_FIELDS, AI_EXTRACTED_FIELDS, EMBEDDING_COLUMNS,
  INTERNAL_COLUMNS, PUBLIC_COLUMNS, CORE_COLUMNS, selectList, getFieldMeta, getFieldNames, isAIField,
  SOURCES, makeScrapId, pinboardScrapId, mastodonScrapId, githubScrapId, arenaScrapId,
  youtubeWatchLaterScrapId, parseScrapId,
  SENTINEL_SOURCES, SENTINEL_SCRAP_IDS, isSentinel,
  CONTROL_TAG_PREFIX, HIDE_TAG, parseTags, isControlTag, publicTags, controlTags, isHidden,
  TITLE_PLACEHOLDERS, AI_TITLE_PREFIXES, isPlaceholderTitle, cleanTitle, hostnameOf, displayTitle,
  normalizeUrl, isPublicScrap, isUsableScrap, SITE_ORIGIN, permalink,
  createEmptyScrap, validateScrap, calculateCompleteness,
}
