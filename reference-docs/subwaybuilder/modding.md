# Modding (from subwaybuilder.com/docs)

Real, verified summary of how Subway Builder mods work. Full docs at subwaybuilder.com/docs.

## What you can mod
- **Custom cities** — maps, demand data, buildings
- **UI** — panels, buttons, overlays
- **Game mechanics** — train types, station behaviors, rules
- **Visuals** — map layers, themes, styles

## How mods run (important)
- Mods are **plain JavaScript** loaded via `new Function()`.
- **ES6 `import` statements do NOT work.** Everything you need comes from the global `window.SubwayBuilderAPI` instead.
- Current API version: **1.0.0**.

## Mod file structure
Each mod is a folder under your `mods/` directory:

```
mods/
└── my-first-mod/
    ├── manifest.json
    └── index.js
```

### manifest.json
```json
{
    "id": "com.yourname.my-first-mod",
    "name": "My First Mod",
    "description": "My first Subway Builder mod!",
    "version": "1.0.0",
    "author": {"name": "Your Name"},
    "main": "index.js"
}
```
- `id` — unique, reverse-domain notation (e.g. `com.yourname.mod`)
- `name` — shown in the mod manager
- `version` — semver
- `author.name` — creator credit
- `main` — entry file (usually `index.js`)
- `description` — optional

### index.js (entry point)
```javascript
(() => {
  const api = window.SubwayBuilderAPI;

  // read game state
  const budget = api.gameState.getBudget();

  // lifecycle hooks
  api.hooks.onGameInit(() => { /* ... */ });
  api.hooks.onDayChange((day) => { /* ... */ });
  api.hooks.onStationBuilt((station) => { /* ... */ });

  // actions
  api.actions.addMoney(1000000);
})();
```

## The API surface (window.SubwayBuilderAPI)
- **`api.utils`** — React, Lucide icons (Settings, Play, Train, MapPin…), shadcn/ui components (Button, Card, Progress, Switch, Label, Input, Badge, Tooltip, Slider), and Recharts for charts
- **`api.gameState`** — `getRoutes()`, `getBudget()`, `getStations()`
- **`api.actions`** — `setMoney()`, `addMoney()`, `setPause()`, `setSpeed()`
- **`api.hooks`** — `onGameInit`, `onDayChange`, `onGameEnd`, `onStationBuilt`
- **`api.i18n`** — multi-language helpers

## Installing a downloaded mod
1. Drop the mod folder into your `mods/` directory.
2. **Restart the game.**
3. Go to **Settings → Mods**, find the mod, and toggle it **ON**.

## Sharing mods
- Mods are shared through the **#mod-sharing channel on the Discord**.

## Best practices (from the docs)
- Wrap your code in an IIFE.
- Prefix your console logs with the mod name.
- Add error handling, and check that `window.SubwayBuilderAPI` exists before using it.

## Note
The docs are versioned (e.g. `/docs/v1.0.0/getting-started/first-mod`). If someone asks about something not covered here, point them to **subwaybuilder.com/docs** rather than guessing.
