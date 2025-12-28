# Passengers & Demand

## How Demand Works

1. Cities have demand points (residential, jobs, airports, universities)
2. Each population group has home and work locations
3. Pops assigned morning (to work) and evening (to home) commute times
4. When commute time arrives, they calculate route

## Mode Choice

Passengers choose walking, driving, or transit based on cost:

```
Driving = (time × wage) + ($0.65/km) + $5 parking
Transit = (time × wage) + fare
Walking = time × wage
```

Income randomly distributed (mean $60k/year). Higher income = value time more.

### Special Populations

- **Airport workers**: 1.5x income, 5x parking cost
- **College students**: 0.6x income (more price-sensitive)

## RAPTOR Pathfinding

Passengers use RAPTOR algorithm for optimal transit routes:
- Max 3 transfers
- Max 30-min walk to first station
- Max 10-min walk between transfers
- Arrive at stations 50 seconds before train

Returns up to 3 alternative paths.

## Journey States

1. Walking to station
2. Waiting for train
3. Riding train
4. Transferring (walking between stations)
5. Walking to destination

## Boarding

- Passengers board during 20-second dwell time
- If train full, they wait for next train
- Station capacity is unlimited

## Warnings

**Capacity Warning**: Train has < 50 empty seats

**Stuck Passenger**: Waiting 12+ hours. Suggests adding more trains.

## Commute Timing

- System checks commutes every 15 game minutes
- Rush hours: 7-9 AM, 5-7 PM (high demand)
- Midday: medium demand
- Night: low demand

## Affecting Ridership

More ridership from:
- Connecting residential to job areas
- Shorter travel times
- Lower fares
- More frequent service
- Hub stations for transfers
