# Trains

## Train Types

### Heavy Metro
- Max speed: 55 mph (89 km/h)
- Capacity: 240 passengers/car
- Cars per train: 5-10
- Car length: 15m
- Cost: $2.5M per car
- Operating: $500/hr + $50/hr per car

### Light Metro
- Max speed: 62 mph (100 km/h)
- Capacity: 200 passengers/car
- Cars per train: 2-4
- Car length: 19m
- Cost: $2.5M per car
- Operating: $400/hr + $40/hr per car

## Speed Limits

Trains automatically slow for:
- **Curves**: Tighter curves = slower speed (physics-based)
- **Slopes**: 3-3.5% grade = 90% speed, 3.5-5% = 80% speed
- **Stations**: All trains limited to ~29 mph through platforms

Max slope allowed: 4%

## Capacity Examples

| Train | Cars | Capacity |
|-------|------|----------|
| Heavy Metro | 5 | 1,200 |
| Heavy Metro | 10 | 2,400 |
| Light Metro | 2 | 400 |
| Light Metro | 4 | 800 |

## Boarding

- Dwell time at stations: 20 seconds
- If train full, passengers wait for next train
- No station capacity limit (unlimited waiting passengers)

## Collision Prevention

- Trains detect other trains via signal system
- Warning window = braking distance + 2m ahead
- Extended lookahead = 100m ahead
- If signal ahead is occupied → train stops immediately

## Stuck Trains

Trains not moving for 15+ minutes are automatically removed.

## Train Purchase

- Heavy Metro: buy in sets of 5 cars
- Light Metro: buy in sets of 2 cars
- Adjust cars per train on route (5-10 heavy, 2-4 light)
