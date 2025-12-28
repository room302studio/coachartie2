# Signals

## Key Fact

**Signals are 100% automatic.** No manual placement. Game regenerates all signals when tracks change.

## Signal Types

| Type | Location | Coverage |
|------|----------|----------|
| Station | Every platform connection | All tracks at node |
| V-Merge | Track junctions | Last 200m of each approach |
| Diamond | Grade crossings | 10m around intersection |
| Scissors | Crossover switches | Both crossover tracks |

## Signal States

- **Green (Free)**: No trains nearby
- **Yellow (Reserved)**: Train approaching
- **Red (Occupied)**: Train in block

## How Collision Prevention Works

Every 0.5 seconds:
1. Each train calculates warning window (braking distance + 2m)
2. Trains mark signals in warning window as "reserved"
3. Trains mark signals at their position as "occupied"
4. Before moving, trains check if signals ahead are blocked by OTHER trains
5. If blocked → instant stop, wait for clear

## Moving Block System

This is similar to modern CBTC (Communications-Based Train Control). Signal blocks move with trains rather than being fixed locations.

## Signal Expiration

Occupations expire after 1 second if not refreshed. Prevents ghost signals from deleted trains.

## Common Issues

**Trains stopping for no reason?**
- Check for conflicting routes at junctions
- May be invisible occupation from another line

**Head-on crashes?**
- Routes using same track with opposite running directions
- Fix: make running direction consistent (all left or all right)
