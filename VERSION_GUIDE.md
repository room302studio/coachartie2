# Version Management Guide

## Quick Reference

```bash
# Bug fixes, security patches, minor improvements
npm run version:patch   # 1.1.0 → 1.1.1

# New features, new capabilities, significant enhancements
npm run version:minor   # 1.1.0 → 1.2.0

# Breaking changes, major rewrites, architecture changes
npm run version:major   # 1.1.0 → 2.0.0
```

## Workflow

### 1. Make Your Changes
Work on features, fixes, or improvements as usual.

### 2. Update CHANGELOG.md
Before bumping version, update `CHANGELOG.md`:

```markdown
## [Unreleased]

### Added
- New feature description

### Fixed
- Bug fix description

### Changed
- Modification description
```

### 3. Bump Version
Choose the appropriate bump:

**PATCH (0.0.x)** - Bug fixes, security patches
```bash
npm run version:patch
```

**MINOR (0.x.0)** - New features (most common)
```bash
npm run version:minor
```

**MAJOR (x.0.0)** - Breaking changes
```bash
npm run version:major
```

This will:
- Update version in `package.json`
- Create a git commit with version tag
- Push changes and tags to remote

### 4. Update CHANGELOG Release Date
After version bump, move `[Unreleased]` to versioned section:

```markdown
## [1.2.0] - 2025-10-26

### Added
- New feature description
```

### 5. Commit CHANGELOG
```bash
git add CHANGELOG.md
git commit -m "docs: Update CHANGELOG for v1.2.0"
git push
```

## Examples

### Adding a New Capability

```bash
# 1. Create the capability code
# 2. Update CHANGELOG.md
## [Unreleased]
### Added
- weather_forecast capability with current conditions and 7-day forecast

# 3. Bump minor version (new feature)
npm run version:minor

# 4. Update CHANGELOG date
## [1.2.0] - 2025-10-26

# 5. Commit and push
git add CHANGELOG.md
git commit -m "docs: Update CHANGELOG for v1.2.0"
git push
```

### Fixing a Bug

```bash
# 1. Fix the bug
# 2. Update CHANGELOG.md
## [Unreleased]
### Fixed
- Memory leak in queue consumer causing OOM errors

# 3. Bump patch version
npm run version:patch

# 4. Update CHANGELOG date
## [1.1.1] - 2025-10-26

# 5. Commit and push
git add CHANGELOG.md
git commit -m "docs: Update CHANGELOG for v1.1.1"
git push
```

## What Counts as What?

### MAJOR (Breaking Changes)
- Complete architecture rewrites
- Removing capabilities
- Changing database schema in incompatible ways
- API endpoint changes that break existing clients
- Switching primary LLM providers

### MINOR (New Features)
- Adding new capabilities ✅ Most common
- Adding new actions to existing capabilities
- New integrations (Discord features, MCPs, etc.)
- Significant performance improvements
- New configuration options

### PATCH (Fixes & Tweaks)
- Bug fixes
- Security patches
- Documentation updates
- Minor performance improvements
- Error message improvements
- Log improvements

## Changelog Template

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- New features and capabilities

### Fixed
- Bug fixes and patches

### Changed
- Modifications to existing features

### Deprecated
- Features marked for removal

### Removed
- Deleted features

### Security
- Security patches and improvements
```

## Current Version: 1.1.0

Last updated: 2025-10-26
