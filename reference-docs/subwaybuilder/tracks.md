# Tracks & Stations

## Station Requirements

Station tracks MUST be:
- **Straight** (no curves allowed)
- **Level** (same elevation at both ends)
- **Correct length**:
  - Heavy Metro: 160m min, 227m max
  - Light Metro: 80m min, 160m max

## Track Types

| Type | Description |
|------|-------------|
| Single | One track, bidirectional |
| Parallel | Two tracks side-by-side |
| Quad | Four tracks (express + local each direction) |

## Station Track Nodes

- Created automatically where two station tracks meet
- These are waypoints for train navigation
- Routes are sequences of these nodes

## Platform Widths

| Track Config | Platform Width |
|--------------|----------------|
| Single | 11.5m |
| Parallel | 15.5m |
| Quad | 23.5m |

## Track Spacing

- Parallel: 2.6m from centerline each side
- Quad inner: 2.6m, outer: 5.4m from centerline

## Station Naming

Stations auto-named from nearby roads. Can be renamed manually.

## Station Capacity

**Stations have NO capacity limit.** Unlimited passengers can wait. Only train capacity limits boarding.

## Scissors Crossover

- Allows trains to switch between parallel tracks
- Heavy Metro: $15M
- Light Metro: $12M
- Creates special signals for safe switching

## Track Connections

Tracks connect at shared coordinate endpoints. System builds graph for pathfinding.

## Reversible Tracks

Station tracks are reversible (bidirectional). Regular tracks are directional.
