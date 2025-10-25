# Coach Artie 2 - Dependency Security Audit Report
**Generated:** 2025-10-25
**Scope:** Full monorepo (8 packages)
**Tools Used:** `pnpm audit`, `pnpm outdated`

---

## Executive Summary

**Status:** ⚠️ **ACTION REQUIRED** - 3 Critical, 5 High, 7 Moderate, 8 Low vulnerabilities identified

**Key Findings:**
- **23 total vulnerabilities** across dependency tree
- **3 critical** issues requiring immediate attention (potential code execution, prototype pollution)
- **5 high-severity** issues (path traversal, XSS, DoS vectors)
- **12 regular package updates** available for major tools
- **Turbo significantly outdated** (1.13.4 → 2.5.8)

---

## 🔴 CRITICAL VULNERABILITIES (Requires Immediate Action)

### 1. **Vite: Arbitrary Code Execution via Transform**
- **Path:** packages/brain > @nuxt/devtools > vite > 7.0.x
- **Severity:** CRITICAL
- **Impact:** Attacker can execute arbitrary code during build process
- **Affected Versions:** Multiple Vite instances (42 paths found)
- **Recommendation:** Update Vite to latest; coordinate with Nuxt upgrade

### 2. **Minimist: Prototype Pollution**
- **Path:** Multiple packages via dependency chain
- **Severity:** CRITICAL
- **Impact:** Attacker can pollute Object prototype, affecting all objects
- **Recommendation:** Update minimist to latest; may require transitive dependency bumps

### 3. **form-data: Unsafe Random Function in Headers**
- **Path:** packages/brain > axios > form-data
- **Severity:** CRITICAL
- **Impact:** Predictable boundary tokens in multipart/form-data requests
- **Recommendation:** Update to form-data ≥4.0.4

**Immediate Action:** These require careful, coordinated updates. Test thoroughly in staging.

---

## 🟠 HIGH SEVERITY VULNERABILITIES

### 1. **Nuxt: Multiple Security Issues**
| Issue | CVE | Fix |
|-------|-----|-----|
| Path Traversal (Island Payload) | GHSA-p6jq-8vc4-79f6 | Upgrade Nuxt to ≥3.19.0 |
| XSS in Markdown (MDC) | High | Included in 3.19.0+ |
| Client-side Path Traversal | GHSA-p6jq-8vc4-79f6 | ≥3.19.0 |

**Current Version:** 3.18.0
**Required Version:** ≥3.19.0
**Blocking:** @nuxt/content@2.13.4 and others

### 2. **devalue: Prototype Pollution**
- **Impact:** Unsafe deserialization of JSON-like data
- **Fix:** Update to ≥5.4.2
- **Path:** packages/brain > nuxt > devalue

### 3. **Axios: DoS via Unhandled Data Size**
- **Impact:** Attacker can crash process with large payloads
- **Fix:** Update Axios to latest patch
- **Current Usage:** packages/brain

### 4. **tar-fs: Symlink Validation Bypass**
- **Impact:** Directory traversal during extraction
- **Path:** packages/brain > better-sqlite3 > prebuild-install > tar-fs
- **Fix:** Update tar-fs to patched version

### 5. **Nodemailer: Email Domain Spoofing**
- **Impact:** Email can be sent to unintended domain
- **Current Version:** 6.10.1
- **Fix:** Update to ≥7.0.0 (requires code review - major version)

---

## 🟡 MODERATE VULNERABILITIES (7 issues)

| Package | Issue | Version | Fix |
|---------|-------|---------|-----|
| esbuild | Server SSRF | Via Nuxt upgrade | - |
| vite | server.fs.deny bypass | Via Nuxt/vite upgrade | Multiple fixes |
| Koa | Open Redirect | Via dependency chain | Verify endpoints |
| @eslint/plugin-kit | ReDoS | 0.3.5+ | Update |
| Other issues | Various | See full audit | As per recommendations |

---

## 🟢 LOW SEVERITY VULNERABILITIES (8 issues)

- Mostly Vite/Nuxt filesystem handling edge cases
- @eslint/plugin-kit regex DoS
- tmp temporary file permissions
- fast-redact prototype pollution (unfixed - no patch available)

---

## 📊 Outdated Packages in Root

**Development Dependencies:**
```
❌ @types/node          20.19.4  →  24.9.1    (4 major versions behind)
❌ @eslint/js            9.30.1  →  9.38.0    (8 minor versions)
❌ TypeScript            5.8.3   →  5.9.3     (Latest stable)
❌ eslint suite          8.35.1  →  8.46.2    (11 minor versions)
❌ turbo                 1.13.4  →  2.5.8     (MAJOR: 1.x → 2.x!)
❌ husky                 8.0.3   →  9.1.7     (Major version)
⚠️  Other deps           Various  (See pnpm outdated for full list)
```

**Production Dependencies:**
```
❌ nodemailer            6.10.1  →  7.0.10    (Major version bump)
```

---

## 🛠️ Upgrade Strategy

### Phase 1: Critical Fixes (This Week)
```bash
# 1. Update form-data (direct dependency fix)
pnpm update form-data@4.0.4

# 2. Update Nuxt ecosystem (coordinate with vite)
pnpm update nuxt@latest @nuxt/content@latest

# 3. Update devalue
pnpm update devalue@latest

# 4. Run full audit
pnpm audit
```

### Phase 2: High-Priority Updates (Next Week)
```bash
# Update Axios and supporting packages
pnpm update axios@latest

# Verify Nodemailer usage before major version bump
# May require code changes (breaking changes in 7.0)
pnpm update nodemailer@7 --save  # Review breaking changes first
```

### Phase 3: Dev Dependencies (After stability)
```bash
# Update development tools
pnpm update --save-dev @types/node@latest
pnpm update --save-dev typescript@latest
pnpm update --save-dev eslint@latest @typescript-eslint/eslint-plugin@latest

# CAREFUL: Turbo 2.x has breaking changes
pnpm update --save-dev turbo@latest  # Review changelog first
```

---

## ⚠️ Known Issues & Workarounds

### `fast-redact` (3.5.0)
- **Status:** No patch available from maintainers
- **Risk:** LOW - only affects sensitive data logging/redaction
- **Workaround:** Use standard JSON.stringify if sensitive data isn't logged

### `minimist` (Embedded)
- **Status:** Coming from Nuxt/build tools
- **Fix:** Will be resolved by Nuxt 3.19.0+ update

### Vite Multiple Paths
- **Status:** 42 different import paths found
- **Root Cause:** Nuxt ecosystem pulls vite as transitive dependency
- **Fix:** Upgrade Nuxt; pnpm will deduplicate remaining instances

---

## 🧪 Testing Checklist After Updates

After applying updates, verify:

```bash
# 1. Full build succeeds
pnpm run build

# 2. No new security issues introduced
pnpm audit

# 3. Type checking passes
pnpm run typecheck

# 4. Linting passes
pnpm run lint

# 5. Tests pass
pnpm run test

# 6. Dev server starts cleanly
pnpm run dev  # Check for startup errors

# 7. Health checks respond
curl http://localhost:47324/health
curl http://localhost:47325/health  # Brain UI
```

---

## 📋 Dependency Matrix

### Production Dependencies
| Package | Type | Current | Status | Impact |
|---------|------|---------|--------|--------|
| nodemailer | Email | 6.10.1 | Vulnerable (Mod) | Email sending |
| blessed | CLI/TUI | 0.1.81 | Old | Low impact |
| csv-parser | Util | 3.2.0 | Current | No vulnerabilities |

### Critical Dev Dependencies
| Package | Current | Latest | Gap | Notes |
|---------|---------|--------|-----|-------|
| turbo | 1.13.4 | 2.5.8 | Major | Build orchestration - breaking changes |
| typescript | 5.8.3 | 5.9.3 | Minor | Type safety |
| @types/node | 20.19.4 | 24.9.1 | 4-major | Node.js type definitions |
| eslint | 9.30.1 | 9.38.0 | Minor | Code quality |

---

## 🎯 Recommendations

### Immediate (Today)
1. ✅ Acknowledge vulnerability scan results
2. ✅ Schedule security patches for form-data and Nuxt
3. ✅ Create feature branch: `chore/security-updates`

### Short-term (This Week)
1. Apply critical vulnerability patches (Phase 1 above)
2. Test thoroughly in staging environment
3. Deploy to production with monitoring
4. Verify production health

### Medium-term (Next Sprint)
1. Update Nuxt and dev dependencies
2. Update Turbo (review breaking changes)
3. Update Node.js types
4. Consider Nodemailer 7.0 upgrade (with code review)

### Long-term
1. Establish quarterly dependency audit schedule
2. Set up Dependabot or similar for continuous monitoring
3. Document security update procedures
4. Automate security checks in CI/CD

---

## 📞 Key Contacts & Resources

**Vulnerability Advisories:**
- https://github.com/advisories - GitHub Security Advisory Database
- npm audit documentation: `pnpm audit --help`

**Package Changelogs:**
- Nuxt: https://github.com/nuxt/nuxt/releases
- Vite: https://github.com/vitejs/vite/releases
- Turbo: https://github.com/vercel/turbo/releases

---

## Appendix: Full Audit Output

```
23 vulnerabilities found
Severity: 8 low | 7 moderate | 5 high | 3 critical

Critical Issues:
├─ Vite: Arbitrary Code Execution (42 paths)
├─ minimist: Prototype Pollution
└─ form-data: Unsafe Random Function

High Issues:
├─ Nuxt: Path Traversal & XSS (3 issues)
├─ devalue: Prototype Pollution
├─ Axios: DoS Attack Vector
├─ tar-fs: Symlink Bypass
└─ Nodemailer: Email Domain Spoofing

Outdated Packages:
├─ @types/node: 20.x → 24.x (4 major versions)
├─ turbo: 1.13.4 → 2.5.8 (major version)
├─ nodemailer: 6.10.1 → 7.0.10 (major version)
└─ TypeScript & ESLint suite: Various minors/patches
```

---

**Report Status:** Complete ✅
**Next Review:** 2025-11-25 (Monthly)
**Owner:** DevOps / Security Team
