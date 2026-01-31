/**
 * Metro Geo Analysis - Turf.js powered spatial analysis for .metro saves
 *
 * Finds interesting patterns and outliers in transit networks:
 * - Isolated stations (far from other stations)
 * - Hub stations (many route connections)
 * - Route efficiency (how direct are the lines?)
 * - Network spread and coverage
 * - Unusual station placements
 */

// @ts-ignore - turf types not fully compatible with exports
import * as turf from '@turf/turf';

export interface GeoInsight {
  type: 'warning' | 'observation' | 'praise';
  category: 'isolation' | 'hub' | 'efficiency' | 'coverage' | 'density' | 'service';
  message: string;
  details?: string;
}

export interface GeoAnalysisResult {
  insights: GeoInsight[];
  stats: {
    networkSpreadKm: number;
    averageStationSpacingKm: number;
    totalNetworkKm: number;
    trainsPerStation: number;
    mostIsolatedStation?: { name: string; distanceKm: number };
    biggestHub?: { name: string; routeCount: number };
    longestRoute?: { name: string; lengthKm: number };
    leastEfficientRoute?: { name: string; efficiency: number };
    longestGap?: { route: string; distanceKm: number };
    deadRoutes?: string[];
    understaffedRoutes?: { name: string; trainsPerKm: number }[];
  };
}

interface Station {
  id: string;
  name: string;
  coords: [number, number]; // [lon, lat]
  routeIds?: string[];
  trackIds?: string[];
}

interface RouteNode {
  id: string;
  center: [number, number]; // [lon, lat]
}

interface RouteCombo {
  startStNodeId: string;
  endStNodeId: string;
  distance: number;
}

interface Route {
  id: string;
  bullet: string;
  stNodes: RouteNode[];
  stCombos?: RouteCombo[];
}

interface Train {
  id: string;
  routeId: string;
}

/**
 * Analyze a metro save file's geographic data
 */
export function analyzeMetroGeo(data: {
  stations?: Station[];
  routes?: Route[];
  trains?: Train[];
}): GeoAnalysisResult {
  const insights: GeoInsight[] = [];
  const stats: GeoAnalysisResult['stats'] = {
    networkSpreadKm: 0,
    averageStationSpacingKm: 0,
    totalNetworkKm: 0,
    trainsPerStation: 0,
  };

  const stations = data.stations || [];
  const routes = data.routes || [];
  const trains = data.trains || [];

  if (stations.length < 3) {
    return { insights: [], stats };
  }

  // Convert stations to GeoJSON points
  const stationPoints = stations
    .filter(s => s.coords && s.coords.length === 2)
    .map(s => turf.point(s.coords, { id: s.id, name: s.name, routeCount: s.routeIds?.length || 0 }));

  if (stationPoints.length < 3) {
    return { insights: [], stats };
  }

  // 1. Network spread (bounding box diagonal)
  try {
    const bbox = turf.bbox(turf.featureCollection(stationPoints));
    const corner1 = turf.point([bbox[0], bbox[1]]);
    const corner2 = turf.point([bbox[2], bbox[3]]);
    stats.networkSpreadKm = turf.distance(corner1, corner2, { units: 'kilometers' });
  } catch {
    // Skip if bbox calculation fails
  }

  // 2. Find isolated stations (far from nearest neighbor)
  const isolationDistances: { station: Station; distanceKm: number }[] = [];

  for (const station of stations) {
    if (!station.coords || station.coords.length !== 2) continue;

    const point = turf.point(station.coords);
    let minDistance = Infinity;

    for (const other of stations) {
      if (other.id === station.id || !other.coords || other.coords.length !== 2) continue;
      const otherPoint = turf.point(other.coords);
      const dist = turf.distance(point, otherPoint, { units: 'kilometers' });
      if (dist < minDistance) {
        minDistance = dist;
      }
    }

    if (minDistance < Infinity) {
      isolationDistances.push({ station, distanceKm: minDistance });
    }
  }

  // Average station spacing
  if (isolationDistances.length > 0) {
    stats.averageStationSpacingKm =
      isolationDistances.reduce((sum, s) => sum + s.distanceKm, 0) / isolationDistances.length;
  }

  // Find most isolated station
  isolationDistances.sort((a, b) => b.distanceKm - a.distanceKm);
  if (isolationDistances.length > 0) {
    const mostIsolated = isolationDistances[0];
    stats.mostIsolatedStation = {
      name: mostIsolated.station.name,
      distanceKm: Math.round(mostIsolated.distanceKm * 10) / 10,
    };

    // Flag if significantly more isolated than average
    if (mostIsolated.distanceKm > stats.averageStationSpacingKm * 3) {
      insights.push({
        type: 'warning',
        category: 'isolation',
        message: `"${mostIsolated.station.name}" is way out there - ${stats.mostIsolatedStation.distanceKm}km from its nearest neighbor`,
        details: `That's ${Math.round(mostIsolated.distanceKm / stats.averageStationSpacingKm)}x your average station spacing. Either it's a strategic outpost or a planning oversight.`,
      });
    }
  }

  // 3. Find hub stations (most route connections)
  const stationRouteCounts = stations
    .filter(s => s.routeIds && s.routeIds.length > 0)
    .map(s => ({ name: s.name, routeCount: s.routeIds!.length }))
    .sort((a, b) => b.routeCount - a.routeCount);

  if (stationRouteCounts.length > 0) {
    const biggestHub = stationRouteCounts[0];
    stats.biggestHub = biggestHub;

    if (biggestHub.routeCount >= 4) {
      insights.push({
        type: 'observation',
        category: 'hub',
        message: `"${biggestHub.name}" is your network's Grand Central - ${biggestHub.routeCount} lines converging`,
        details: `Major transfer point. If it gets crowded, consider express bypasses or parallel capacity.`,
      });
    }
  }

  // 4. Analyze route efficiency, gaps, and total network length
  const routeEfficiencies: { name: string; efficiency: number; lengthKm: number }[] = [];
  let totalNetworkKm = 0;
  let longestGap: { route: string; distanceKm: number; segment: string } | null = null;

  for (const route of routes) {
    if (!route.stNodes || route.stNodes.length < 2) continue;

    const nodes = route.stNodes.filter(n => n.center && n.center.length === 2);
    if (nodes.length < 2) continue;

    const routeName = route.bullet || `Route ${route.id.slice(0, 6)}`;

    try {
      // Calculate actual route length and find longest gap
      let actualLength = 0;
      for (let i = 1; i < nodes.length; i++) {
        const p1 = turf.point(nodes[i - 1].center);
        const p2 = turf.point(nodes[i].center);
        const segmentDist = turf.distance(p1, p2, { units: 'kilometers' });
        actualLength += segmentDist;

        // Track longest gap between stations
        if (!longestGap || segmentDist > longestGap.distanceKm) {
          longestGap = {
            route: routeName,
            distanceKm: segmentDist,
            segment: `segment ${i}`,
          };
        }
      }

      totalNetworkKm += actualLength;

      // Calculate straight-line distance (first to last)
      const firstPoint = turf.point(nodes[0].center);
      const lastPoint = turf.point(nodes[nodes.length - 1].center);
      const straightLine = turf.distance(firstPoint, lastPoint, { units: 'kilometers' });

      // Efficiency = straight line / actual (1.0 = perfectly straight)
      const efficiency = straightLine > 0 ? straightLine / actualLength : 1;

      routeEfficiencies.push({
        name: routeName,
        efficiency: Math.round(efficiency * 100) / 100,
        lengthKm: Math.round(actualLength * 10) / 10,
      });
    } catch {
      // Skip routes with invalid geometry
    }
  }

  stats.totalNetworkKm = Math.round(totalNetworkKm * 10) / 10;
  stats.trainsPerStation = stations.length > 0 ? Math.round((trains.length / stations.length) * 100) / 100 : 0;

  // Flag if there's a very long gap (over 5km between stations)
  if (longestGap && longestGap.distanceKm > 5) {
    stats.longestGap = {
      route: longestGap.route,
      distanceKm: Math.round(longestGap.distanceKm * 10) / 10,
    };
    insights.push({
      type: 'observation',
      category: 'coverage',
      message: `"${longestGap.route}" has a ${stats.longestGap.distanceKm}km gap between stations`,
      details: `That's a long ride without a stop. Consider adding an intermediate station if there's demand.`,
    });
  }

  // Find longest route
  routeEfficiencies.sort((a, b) => b.lengthKm - a.lengthKm);
  if (routeEfficiencies.length > 0) {
    stats.longestRoute = {
      name: routeEfficiencies[0].name,
      lengthKm: routeEfficiencies[0].lengthKm,
    };
  }

  // Find least efficient (most winding) route
  routeEfficiencies.sort((a, b) => a.efficiency - b.efficiency);
  if (routeEfficiencies.length > 0 && routeEfficiencies[0].efficiency < 0.6) {
    const worstRoute = routeEfficiencies[0];
    stats.leastEfficientRoute = {
      name: worstRoute.name,
      efficiency: worstRoute.efficiency,
    };

    insights.push({
      type: 'observation',
      category: 'efficiency',
      message: `"${worstRoute.name}" takes the scenic route - only ${Math.round(worstRoute.efficiency * 100)}% direct`,
      details: `It meanders ${Math.round((1 / worstRoute.efficiency - 1) * 100)}% longer than a straight shot. Sometimes geography demands it, but passengers feel every extra minute.`,
    });
  }

  // 5. Praise for good network characteristics
  if (stats.networkSpreadKm > 50) {
    insights.push({
      type: 'praise',
      category: 'coverage',
      message: `Impressive reach - your network spans ${Math.round(stats.networkSpreadKm)}km corner to corner`,
      details: `That's serious regional coverage. Make sure your outer stations have good frequency.`,
    });
  }

  // 6. Check for clustering (too many stations in one area)
  if (stations.length > 20 && stats.averageStationSpacingKm < 0.3) {
    insights.push({
      type: 'warning',
      category: 'density',
      message: `Stations are packed tight - averaging just ${Math.round(stats.averageStationSpacingKm * 1000)}m apart`,
      details: `Dense networks are expensive to run. Consider consolidating some stops or running express services through the core.`,
    });
  }

  // 7. Check for potential dead-end stations (only 1 route connection, far from center)
  const potentialDeadEnds = stations.filter(s => {
    const routeCount = s.routeIds?.length || 0;
    return routeCount === 1;
  });

  if (potentialDeadEnds.length > stations.length * 0.3) {
    insights.push({
      type: 'observation',
      category: 'coverage',
      message: `${potentialDeadEnds.length} stations are single-line only - that's ${Math.round(potentialDeadEnds.length / stations.length * 100)}% of your network`,
      details: `A lot of terminal/branch stations. Not necessarily bad, but passengers there have limited options if something goes wrong.`,
    });
  }

  // 8. Route service level analysis
  if (trains.length > 0 && routes.length > 0) {
    // Count trains per route
    const trainsByRoute: Record<string, number> = {};
    for (const train of trains) {
      if (train.routeId) {
        trainsByRoute[train.routeId] = (trainsByRoute[train.routeId] || 0) + 1;
      }
    }

    const deadRoutes: string[] = [];
    const understaffedRoutes: { name: string; trainsPerKm: number; trainCount: number; lengthKm: number }[] = [];

    for (const route of routes) {
      const routeName = route.bullet || `Route ${route.id.slice(0, 6)}`;
      const trainCount = trainsByRoute[route.id] || 0;

      // Calculate route length from stCombos (more accurate) or stNodes
      let routeLengthKm = 0;
      if (route.stCombos && route.stCombos.length > 0) {
        for (const combo of route.stCombos) {
          routeLengthKm += (combo.distance || 0) / 1000;
        }
      } else if (route.stNodes && route.stNodes.length >= 2) {
        // Fallback to calculating from node positions
        const nodes = route.stNodes.filter(n => n.center && n.center.length === 2);
        for (let i = 1; i < nodes.length; i++) {
          try {
            const p1 = turf.point(nodes[i - 1].center);
            const p2 = turf.point(nodes[i].center);
            routeLengthKm += turf.distance(p1, p2, { units: 'kilometers' });
          } catch {
            // Skip invalid segments
          }
        }
      }

      // Skip trunk routes or routes with no stations
      if (!route.stNodes || route.stNodes.length === 0) continue;

      if (trainCount === 0) {
        deadRoutes.push(routeName);
      } else if (routeLengthKm > 5) {
        // Only check density for routes > 5km
        const trainsPerKm = trainCount / routeLengthKm;
        // Low density = less than 0.15 trains per km (roughly 1 train per 6.5km)
        if (trainsPerKm < 0.15) {
          understaffedRoutes.push({
            name: routeName,
            trainsPerKm: Math.round(trainsPerKm * 100) / 100,
            trainCount,
            lengthKm: Math.round(routeLengthKm * 10) / 10,
          });
        }
      }
    }

    // Report dead routes
    if (deadRoutes.length > 0) {
      stats.deadRoutes = deadRoutes;
      insights.push({
        type: 'warning',
        category: 'service',
        message: `${deadRoutes.length} route${deadRoutes.length > 1 ? 's have' : ' has'} no trains running: ${deadRoutes.slice(0, 3).join(', ')}${deadRoutes.length > 3 ? '...' : ''}`,
        details: `Ghost lines bleeding your budget. Either assign trains or delete the route.`,
      });
    }

    // Report understaffed routes (worst offenders)
    understaffedRoutes.sort((a, b) => a.trainsPerKm - b.trainsPerKm);
    if (understaffedRoutes.length > 0) {
      stats.understaffedRoutes = understaffedRoutes.slice(0, 3).map(r => ({
        name: r.name,
        trainsPerKm: r.trainsPerKm,
      }));

      const worst = understaffedRoutes[0];
      insights.push({
        type: 'warning',
        category: 'service',
        message: `"${worst.name}" is stretched thin - ${worst.trainCount} trains for ${worst.lengthKm}km`,
        details: `Only ${worst.trainsPerKm.toFixed(2)} trains/km. Passengers are waiting. Either add trains or shorten the line.`,
      });
    }
  }

  return { insights, stats };
}

/**
 * Format geo analysis as a narrative string for the AI to use
 */
export function formatGeoInsights(result: GeoAnalysisResult): string {
  if (result.insights.length === 0) {
    return '';
  }

  const lines: string[] = ['📍 **Network Design Feedback** _(manual fixes - not auto-repaired):_'];

  for (const insight of result.insights) {
    const emoji = insight.type === 'warning' ? '⚠️' : insight.type === 'praise' ? '👏' : '📊';
    lines.push(`${emoji} ${insight.message}`);
    if (insight.details) {
      lines.push(`   _${insight.details}_`);
    }
  }

  // Add key stats
  const { stats } = result;
  const statParts: string[] = [];

  if (stats.totalNetworkKm > 0) {
    statParts.push(`${Math.round(stats.totalNetworkKm)}km total track`);
  }
  if (stats.networkSpreadKm > 0) {
    statParts.push(`${Math.round(stats.networkSpreadKm)}km spread`);
  }
  if (stats.averageStationSpacingKm > 0) {
    statParts.push(`~${Math.round(stats.averageStationSpacingKm * 1000)}m avg spacing`);
  }

  if (statParts.length > 0) {
    lines.push(`📐 Network: ${statParts.join(' | ')}`);
  }

  // Add service stats
  const serviceParts: string[] = [];
  if (stats.trainsPerStation > 0) {
    serviceParts.push(`${stats.trainsPerStation} trains/station`);
  }
  if (stats.longestRoute) {
    serviceParts.push(`longest: ${stats.longestRoute.name} (${stats.longestRoute.lengthKm}km)`);
  }

  if (serviceParts.length > 0) {
    lines.push(`🚂 Service: ${serviceParts.join(' | ')}`);
  }

  return lines.join('\n');
}
