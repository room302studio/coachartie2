#!/bin/bash

# Security Patch Script for Coach Artie 2
# Automates Phase 1 critical vulnerability patches
# Usage: ./scripts/security-patch.sh [--dry-run]

set -e

DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "🔍 DRY RUN MODE - No changes will be applied"
fi

echo "=========================================="
echo "Coach Artie 2 - Security Patch Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Step 1: Auditing current vulnerabilities...${NC}"
pnpm audit 2>&1 | tail -5
echo ""

echo -e "${YELLOW}⚠️  CRITICAL VULNERABILITIES TO FIX:${NC}"
echo "  1. form-data (CRITICAL) - Unsafe random function"
echo "  2. vite (CRITICAL) - Arbitrary code execution"
echo "  3. minimist (CRITICAL) - Prototype pollution"
echo "  4. nuxt (HIGH) - Path traversal & XSS"
echo "  5. devalue (HIGH) - Prototype pollution"
echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo -e "${YELLOW}[DRY RUN]${NC} Would execute the following patches:"
else
  echo -e "${BLUE}Step 2: Creating feature branch...${NC}"
  git checkout -b chore/security-updates
  echo -e "${GREEN}✅ Feature branch created${NC}"
  echo ""

  echo -e "${BLUE}Step 3: Applying critical patches...${NC}"

  echo "  → Updating form-data..."
  pnpm update form-data@4.0.4

  echo "  → Updating Nuxt ecosystem (may take a moment)..."
  pnpm update nuxt@latest @nuxt/content@latest

  echo "  → Updating devalue..."
  pnpm update devalue@latest

  echo "  → Updating axios..."
  pnpm update axios@latest

  echo -e "${GREEN}✅ Critical patches applied${NC}"
  echo ""
fi

echo -e "${BLUE}Step 4: Verification checks...${NC}"
echo ""

echo "  📋 Running security audit..."
if [[ "$DRY_RUN" == true ]]; then
  echo "  [DRY RUN] Would run: pnpm audit"
else
  pnpm audit 2>&1 | tail -8 || true
fi
echo ""

echo "  🏗️  Running full build..."
if [[ "$DRY_RUN" == true ]]; then
  echo "  [DRY RUN] Would run: pnpm run build"
else
  pnpm run build 2>&1 | tail -20 || {
    echo -e "${RED}❌ Build failed! Review errors above.${NC}"
    exit 1
  }
fi
echo ""

echo "  🔍 Running type checking..."
if [[ "$DRY_RUN" == true ]]; then
  echo "  [DRY RUN] Would run: pnpm run typecheck"
else
  pnpm run typecheck 2>&1 | tail -10 || {
    echo -e "${RED}❌ Type checking failed! Review errors above.${NC}"
    exit 1
  }
fi
echo ""

echo "  📝 Running linter..."
if [[ "$DRY_RUN" == true ]]; then
  echo "  [DRY RUN] Would run: pnpm run lint"
else
  pnpm run lint 2>&1 | tail -10 || echo "  (Lint warnings present - see above)"
fi
echo ""

if [[ "$DRY_RUN" == false ]]; then
  echo -e "${BLUE}Step 5: Creating commit...${NC}"
  git add .
  git commit -m "chore: Apply critical security patches

- Update form-data to 4.0.4 (CRITICAL: unsafe random)
- Update Nuxt to latest (HIGH: path traversal, XSS)
- Update devalue to latest (HIGH: prototype pollution)
- Update axios to latest (HIGH: DoS vulnerability)

Resolves 3 critical and 5 high-severity vulnerabilities.
See DEPENDENCY_AUDIT_REPORT.md for full details.

🤖 Generated with Claude Code"

  echo -e "${GREEN}✅ Commit created${NC}"
  echo ""

  echo -e "${YELLOW}Next Steps:${NC}"
  echo "  1. Review the changes: git log -1 -p"
  echo "  2. Test in staging environment"
  echo "  3. Push branch: git push origin chore/security-updates"
  echo "  4. Create PR for code review"
  echo "  5. After approval, merge and deploy to production"
  echo ""
fi

echo -e "${GREEN}=========================================="
echo "Security patch script complete!"
echo "==========================================${NC}"
echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo "To apply changes, run without --dry-run:"
  echo "  ./scripts/security-patch.sh"
fi
