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

import { logger, isOwner } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { readFileSync } from 'fs';

// Default coordinates are only used for owner — never exposed to other users
const DEFAULT_LAT = 41.75;
const DEFAULT_LON = -73.95;

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

      // ── live aircraft (adsb.lol) ───────────────────────
      case 'nearby-aircraft': {
        // Location-sensitive: only owner can use default/live location
        const callerId = ctx?.userId;
        if (!callerId || !isOwner(callerId)) {
          return JSON.stringify({
            success: false,
            error: 'This capability requires location access and is restricted to the server owner.',
          });
        }

        let lat = params.lat ? Number(params.lat) : null;
        let lon = params.lon ? Number(params.lon) : null;

        // If no explicit coords, try OwnTracks for live location
        if (!lat || !lon) {
          try {
            let otAuthToken = '';
            try {
              otAuthToken = readFileSync('/home/debian/services/owntracks/.env', 'utf-8')
                .split('\n')
                .find((l: string) => l.startsWith('OWNTRACKS_AUTH_TOKEN='))
                ?.split('=')[1]?.trim() || '';
            } catch { /* no token file */ }

            const otHeaders: Record<string, string> = {};
            if (otAuthToken) otHeaders['Authorization'] = `Bearer ${otAuthToken}`;

            const otResponse = await fetch('http://localhost:7785/latest', {
              headers: otHeaders,
              signal: AbortSignal.timeout(5000),
            });
            if (otResponse.ok) {
              const otData: any = await otResponse.json();
              if (otData.lat && otData.lon) {
                lat = otData.lat;
                lon = otData.lon;
                logger.info(`📍 Using OwnTracks live location: ${lat}, ${lon}`);
              }
            }
          } catch (e) {
            logger.warn('OwnTracks location fetch failed, using default', e);
          }
        }

        // Final fallback to default coords
        if (!lat || !lon) {
          lat = DEFAULT_LAT;
          lon = DEFAULT_LON;
          logger.info('📍 Using default Hudson Valley coordinates');
        }

        const dist = params.dist || 25; // nautical miles
        const response = await fetch(
          `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (!response.ok) throw new Error(`adsb.lol API error: ${response.status}`);
        const adsbData: any = await response.json();
        const aircraft = (adsbData.ac || [])
          .filter((a: any) => a.alt_baro && a.alt_baro !== 'ground')
          .sort((a: any, b: any) => (a.alt_baro || 99999) - (b.alt_baro || 99999))
          .slice(0, 10)
          .map((a: any) => ({
            callsign: (a.flight || '').trim(),
            type: a.t || 'unknown',
            altitude_ft: a.alt_baro,
            speed_kts: a.gs,
            lat: a.lat,
            lon: a.lon,
            hex: a.hex,
            squawk: a.squawk,
            category: a.category,
          }));
        return JSON.stringify({
          success: true,
          center: { lat, lon },
          radius_nm: dist,
          count: aircraft.length,
          total_in_range: (adsbData.ac || []).length,
          aircraft,
        });
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
          error: `Unknown action: ${action}. Available: recent-signals, lookup-signal, search-signals, investigations, lookup-flight, recent-flights, military-activity, flight-anomalies, nearby-aircraft, lookup-entity, explain`,
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
    'nearby-aircraft',
    'lookup-entity',
    'explain',
  ],
  description:
    'Query the OSINT monitoring stack (anomalywatch, skywatch, entityhub) and live aircraft data. Use this when EJ asks about alerts, flights, signals, entities, investigations, or what planes are nearby/overhead. The "nearby-aircraft" action queries live ADS-B data. The "explain" action searches all sources at once for a term.',
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
    '<capability name="osint" action="nearby-aircraft" /> - Live aircraft overhead right now (defaults to Hudson Valley)',
    '<capability name="osint" action="nearby-aircraft" lat="40.7" lon="-74.0" dist="10" /> - Live aircraft near specific coordinates',
    '<capability name="osint" action="lookup-entity" query="Stewart ANG" /> - Look up entity in entityhub',
  ],
};

export default osintLookupCapability;
