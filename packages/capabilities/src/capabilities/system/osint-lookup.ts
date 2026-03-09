/**
 * OSINT Lookup Capability
 *
 * Gives Artie access to the OSINT monitoring stack:
 * - anomalywatch: intelligence signals, scores, investigations
 * - skywatch: aircraft tracking, military/notable flights
 * - entityhub: people, organizations, locations being tracked
 *
 * When EJ asks about an alert or signal, Artie can look up the
 * actual data instead of guessing from training data.
 */

import { logger } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { readFileSync } from 'fs';

const OSINT_APIS = {
  anomalywatch: 'https://anomalywatch.tools.ejfox.com',
  skywatch: 'https://skywatch.tools.ejfox.com',
  entityhub: 'https://entityhub.tools.ejfox.com',
};

function getAnomalywatchToken(): string | null {
  try {
    return readFileSync('/opt/docker/smallweb/data/anomalywatch/data/.api-token', 'utf-8').trim();
  } catch {
    try {
      return readFileSync('/opt/docker/smallweb/data/_shared/.anomalywatch-token', 'utf-8').trim();
    } catch {
      return null;
    }
  }
}

async function osintFetch(baseUrl: string, path: string, token?: string | null): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

interface OsintParams {
  action: string;
  query?: string;
  signal_id?: string;
  icao24?: string;
  callsign?: string;
  entity_id?: string;
  limit?: number;
  [key: string]: unknown;
}

async function handleOsintLookup(
  params: OsintParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const token = getAnomalywatchToken();

  logger.info(`🔍 OSINT lookup - Action: ${action}`);

  try {
    switch (action) {
      // ── anomalywatch signals ──────────────────────────
      case 'recent-signals': {
        const limit = params.limit || 10;
        const data = await osintFetch(
          OSINT_APIS.anomalywatch,
          `/api/signals?limit=${limit}&min_score=1.5`,
          token
        );
        const signals = (Array.isArray(data) ? data : data.signals || []).slice(0, limit);
        const summary = signals.map((s: any) => ({
          id: s.id,
          title: s.title,
          source: s.source,
          score: s.final_score || s.anomaly_score,
          type: s.signal_type,
          time: s.ingested_at || s.timestamp,
        }));
        return JSON.stringify({ success: true, count: summary.length, signals: summary });
      }

      case 'lookup-signal': {
        const id = params.signal_id || params.query || content;
        if (!id) return JSON.stringify({ success: false, error: 'signal_id or query required' });

        // Try direct ID lookup first
        try {
          const signal = await osintFetch(
            OSINT_APIS.anomalywatch,
            `/api/signals/${encodeURIComponent(id)}`,
            token
          );
          return JSON.stringify({ success: true, signal });
        } catch {
          // Fall through to search
        }

        // Search by title/content
        const results = await osintFetch(
          OSINT_APIS.anomalywatch,
          `/api/query?q=${encodeURIComponent(id)}&limit=5`,
          token
        );
        return JSON.stringify({
          success: true,
          query: id,
          results: Array.isArray(results) ? results : results.results || [],
        });
      }

      case 'search-signals': {
        const query = params.query || content;
        if (!query) return JSON.stringify({ success: false, error: 'query required' });

        const results = await osintFetch(
          OSINT_APIS.anomalywatch,
          `/api/query?q=${encodeURIComponent(query)}&limit=${params.limit || 10}`,
          token
        );
        return JSON.stringify({
          success: true,
          query,
          results: Array.isArray(results) ? results : results.results || [],
        });
      }

      case 'investigations': {
        const data = await osintFetch(OSINT_APIS.anomalywatch, '/api/investigations', token);
        const investigations = (Array.isArray(data) ? data : data.investigations || [])
          .filter((inv: any) => inv.status === 'active')
          .map((inv: any) => ({
            id: inv.id,
            title: inv.title,
            priority: inv.priority,
            signal_count: inv.signal_count,
          }));
        return JSON.stringify({ success: true, investigations });
      }

      // ── skywatch flights ──────────────────────────────
      case 'lookup-flight': {
        const icao = params.icao24;
        const callsign = params.callsign || params.query || content;

        if (icao) {
          const flight = await osintFetch(OSINT_APIS.skywatch, `/api/flight/${encodeURIComponent(icao)}`);
          return JSON.stringify({ success: true, flight });
        }

        if (callsign) {
          // Search notable sightings for this callsign
          const data = await osintFetch(
            OSINT_APIS.skywatch,
            `/api/notable?callsign=${encodeURIComponent(callsign)}&limit=10`
          );
          return JSON.stringify({
            success: true,
            callsign,
            sightings: Array.isArray(data) ? data : data.sightings || data.flights || [],
          });
        }

        return JSON.stringify({ success: false, error: 'icao24 or callsign required' });
      }

      case 'recent-flights': {
        const data = await osintFetch(OSINT_APIS.skywatch, '/api/daily-stats');
        return JSON.stringify({ success: true, stats: data });
      }

      case 'military-activity': {
        const data = await osintFetch(OSINT_APIS.skywatch, '/api/analysis/military');
        return JSON.stringify({ success: true, military: data });
      }

      case 'flight-anomalies': {
        const data = await osintFetch(OSINT_APIS.skywatch, '/api/anomalies');
        return JSON.stringify({ success: true, anomalies: data });
      }

      // ── entityhub entities ────────────────────────────
      case 'lookup-entity': {
        const id = params.entity_id;
        const query = params.query || content;

        if (id) {
          const entity = await osintFetch(
            OSINT_APIS.entityhub,
            `/api/entity/${encodeURIComponent(id)}`
          );
          return JSON.stringify({ success: true, entity });
        }

        if (query) {
          const entity = await osintFetch(
            OSINT_APIS.entityhub,
            `/api/resolve?q=${encodeURIComponent(query)}`
          );
          return JSON.stringify({ success: true, query, entity });
        }

        return JSON.stringify({ success: false, error: 'entity_id or query required' });
      }

      // ── explain: contextual helper ────────────────────
      case 'explain': {
        // Look up whatever the user is asking about across all sources
        const query = params.query || content;
        if (!query) return JSON.stringify({ success: false, error: 'query required' });

        const results: any = { success: true, query, sources: {} };

        // Search anomalywatch signals
        try {
          const signals = await osintFetch(
            OSINT_APIS.anomalywatch,
            `/api/query?q=${encodeURIComponent(query)}&limit=5`,
            token
          );
          const signalList = Array.isArray(signals) ? signals : signals.results || [];
          if (signalList.length > 0) results.sources.anomalywatch = signalList;
        } catch (e) {
          logger.warn('OSINT explain: anomalywatch search failed', e);
        }

        // Search skywatch if it looks like a callsign or aircraft
        if (/^[A-Z]{2,4}\d{1,4}[A-Z]?$/i.test(query) || /^[0-9a-f]{6}$/i.test(query)) {
          try {
            const isHex = /^[0-9a-f]{6}$/i.test(query);
            const path = isHex
              ? `/api/flight/${query.toLowerCase()}`
              : `/api/notable?callsign=${encodeURIComponent(query)}&limit=5`;
            const flights = await osintFetch(OSINT_APIS.skywatch, path);
            results.sources.skywatch = flights;
          } catch (e) {
            logger.warn('OSINT explain: skywatch search failed', e);
          }
        }

        // Search entityhub
        try {
          const entity = await osintFetch(
            OSINT_APIS.entityhub,
            `/api/resolve?q=${encodeURIComponent(query)}`
          );
          if (entity && (entity.id || entity.canonical_name)) {
            results.sources.entityhub = entity;
          }
        } catch (e) {
          logger.warn('OSINT explain: entityhub search failed', e);
        }

        return JSON.stringify(results);
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Available: recent-signals, lookup-signal, search-signals, investigations, lookup-flight, recent-flights, military-activity, flight-anomalies, lookup-entity, explain`,
        });
    }
  } catch (error) {
    logger.error(`❌ OSINT lookup error for action '${action}':`, error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const osintLookupCapability: RegisteredCapability = {
  name: 'osint',
  emoji: '🔍',
  supportedActions: [
    'recent-signals',
    'lookup-signal',
    'search-signals',
    'investigations',
    'lookup-flight',
    'recent-flights',
    'military-activity',
    'flight-anomalies',
    'lookup-entity',
    'explain',
  ],
  description:
    'Query the OSINT monitoring stack (anomalywatch, skywatch, entityhub). Use this when EJ asks about alerts, flights, signals, entities, or investigations. The "explain" action searches all sources at once for a term.',
  handler: handleOsintLookup,
  examples: [
    '<capability name="osint" action="explain" query="PAT691" /> - Look up a callsign/term across all OSINT sources',
    '<capability name="osint" action="lookup-flight" callsign="PAT691" /> - Get flight details from skywatch',
    '<capability name="osint" action="lookup-flight" icao24="a1b2c3" /> - Look up aircraft by ICAO hex',
    '<capability name="osint" action="recent-signals" limit="5" /> - Latest intelligence signals',
    '<capability name="osint" action="search-signals" query="Stewart ANG" /> - Search signals by keyword',
    '<capability name="osint" action="lookup-signal" signal_id="sig-abc123" /> - Get full signal details',
    '<capability name="osint" action="investigations" /> - List active investigations',
    '<capability name="osint" action="military-activity" /> - Recent military flight analysis',
    '<capability name="osint" action="lookup-entity" query="Stewart ANG" /> - Look up entity in entityhub',
  ],
};

export default osintLookupCapability;
