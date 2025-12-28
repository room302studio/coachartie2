# Routes

## Creating Routes

1. Click "New Route"
2. Set: bullet name (A-Z, 0-9), color, shape, train type
3. **Train type cannot be changed after creation**
4. Click "Edit Route" to add stations
5. Click stations on map in order
6. System auto-finds shortest track path between stations
7. Confirm to activate

## Running Direction

- Routes have left-hand or right-hand running
- **Mixing directions on same tracks = head-on collisions**
- Check route settings if trains crash

## Frequency Formula

```
Headway = Route Cycle Time / Number of Trains
TPH = 60 / Headway (in minutes)
```

Example: 10-min route with 5 trains = 2-min headway = 30 TPH

## Train Scheduling

Three demand levels per route:
- **High**: Rush hours (7-9 AM, 5-7 PM)
- **Medium**: Midday
- **Low**: Night/early morning

Set different train counts for each level. Game smoothly ramps up/down.

## Editing Active Routes

When you edit a route with trains running:
- Game creates temporary routes to redirect trains
- Trains finish current segment, then switch to updated route
- No teleporting or stuck trains
- Temp routes auto-delete when unused

## Route Variants

Create express/local patterns:
1. Click "Create Variant" on existing route
2. Variant copies all stations
3. Remove stops for skip-stop pattern
4. Types: Express, Local, Limited, Super Express, Rush Hour
5. Shares color/bullet with parent

## Suspending Routes

- Suspend route to stop all trains
- Allows track editing on that line
- Resume to restart service
