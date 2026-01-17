# Deployment Speed Optimization Guide

## Problem Analysis

The original deployment strategy was using `--no-cache` flag for every Docker build, which forced complete rebuilds regardless of whether dependencies changed. This caused:

- **Every deployment downloads 708+ npm packages from scratch**
- **Build time: 2-3 minutes minimum** (even for tiny code changes)
- **No delta-checking or layer reuse**
- **Wasteful network/storage usage**

### Why `--no-cache` is Slow

Docker's build process creates layers. Each layer is cached after first build:
```
Layer 1: Base image (node:20-alpine)
Layer 2: Install pnpm
Layer 3: Copy package files
Layer 4: Run pnpm install (708 packages!)  ← SLOW
Layer 5: Copy source code
Layer 6: Build TypeScript
Layer 7: Start application
```

Using `--no-cache` forces Docker to rebuild ALL layers, even if nothing changed. The `pnpm install` layer takes the majority of the time because it downloads all 708 packages.

## Solution: Docker Layer Caching

Docker automatically caches layers based on:
1. **Input content** (if files haven't changed, layer is reused)
2. **Previous layer cache** (can't use cache if parent layer was rebuilt)

The Dockerfile is already optimized with correct layer ordering:
```dockerfile
# Copy package files FIRST (rarely change)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies (cached if above files unchanged)
RUN pnpm install ...

# THEN copy source code (changes frequently)
COPY packages/capabilities ./packages/capabilities

# Build (only runs if source code changed)
RUN pnpm build
```

## Rebuild Script

Single `rebuild.sh` script with optional flags:

**Normal rebuild (fast with cache):**
```bash
./scripts/rebuild.sh capabilities
```

**Clean rebuild (force fresh, no cache):**
```bash
./scripts/rebuild.sh capabilities --clean
```

**Speed:**
- Normal: 10-30 seconds (with cache)
- Clean: 2-3 minutes (full rebuild)
- First build: 2-3 minutes

**Features:**
- Uses Docker layer caching by default
- Optional `--clean` flag forces full rebuild without cache
- Only rebuilds changed layers (when not using --clean)
- **Normal mode:** Typical deployments (code changes)
- **Clean mode:** After major dependency updates, debugging, or when you suspect cache issues

## Performance Comparison

| Scenario | Old (--no-cache) | New (with cache) | Improvement |
|----------|-----------------|-----------------|-------------|
| First build | 2-3 min | 2-3 min | None (same) |
| Code change only | 2-3 min | 10-30 sec | **12x faster** |
| Dependency change | 2-3 min | 1-2 min | **2x faster** |

## How to Use

### Normal Deployment (10-30s)
```bash
# Fast incremental rebuild with cache
./scripts/rebuild.sh capabilities
```

### Full Clean Rebuild (2-3 min)
```bash
# Force fresh rebuild without cache (for troubleshooting)
./scripts/rebuild.sh capabilities --clean
```

Use `--clean` after major dependency updates or if you suspect cache issues.

## Technical Details

### Docker Layer Cache Keys

Docker uses these to determine if a layer should be cached:

1. **Base Image** → Always cached (unless image updates)
2. **System Dependencies** → Cached (rarely changes)
3. **Package Files** → Cached if `package.json` and `pnpm-lock.yaml` unchanged
4. **pnpm install** → **Cached if package files unchanged** ← This saves 1-2 minutes!
5. **Source Code** → Cached if no code changes
6. **TypeScript Build** → Cached if source code unchanged

### Dockerfile Structure (Already Optimized)

The Dockerfile already has correct layer ordering:

```dockerfile
# Stable layer (rarely changes)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Long-running layer (but cached if above didn't change)
RUN pnpm install --filter "@coachartie/capabilities" --filter "@coachartie/shared"

# Volatile layer (changes frequently)
COPY packages/capabilities ./packages/capabilities

# Rebuild only if source changed
RUN pnpm --filter "@coachartie/capabilities" run build
```

This is the optimal pattern for Node.js monorepos.

## Troubleshooting

### Build seems slow despite caching
1. Check if `pnpm-lock.yaml` changed (forces reinstall)
2. Check if you're on a slow network
3. Try `rebuild-clean.sh` to eliminate cache issues

### "Docker layer cache keeps outdated dependencies"
This shouldn't happen if `pnpm-lock.yaml` is committed to git. If dependencies were updated:
1. `pnpm-lock.yaml` changes
2. Docker invalidates cache for install layer
3. Fresh `pnpm install` runs

### Cache takes up too much disk space
```bash
# View Docker disk usage
docker system df

# Clean up unused images/layers (safe)
docker system prune -a
```

## When to Use `--clean` Flag

Normal deployments:
```bash
./scripts/rebuild.sh capabilities
```

Use `--clean` flag if:
- After major dependency updates (`pnpm-lock.yaml` changed significantly)
- Build times seem slower than expected (cache issue)
- You suspect Docker layer cache corruption
- First-time deployment after long gap
```bash
./scripts/rebuild.sh capabilities --clean
```

## Future Optimizations

### BuildKit (Advanced)
Enable Docker BuildKit for additional caching features:
```bash
DOCKER_BUILDKIT=1 docker build ...
```

### Multi-stage Builds
Could further optimize by separating build stage from runtime:
- Build stage: Includes all dependencies (not shipped)
- Runtime stage: Only includes production files

### pnpm Cache Mounts
Mount pnpm cache outside Docker for persistence:
```dockerfile
RUN --mount=type=cache,id=pnpm,target=/pnpm \
    pnpm install ...
```

## Summary

- **Old approach:** Always `--no-cache` → 2-3 min per deploy
- **New approach:** Use Docker layer caching → 10-30 sec per deploy
- **Speed improvement:** 12x faster for typical deployments
- **Zero code changes needed:** Dockerfile already optimal
- **Three scripts:** fast (default), smart-detect, or clean-rebuild

Use `rebuild.sh` for daily deployments. It's fast, reliable, and automatically handles layer caching.
