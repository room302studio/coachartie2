#!/usr/bin/env bash
# Is prompt caching actually working?
#
# A cache that silently stops matching does not raise anything — it just costs more. The
# only ground truth is cached_tokens coming back from OpenRouter, so check this after the
# first few replies following any change to prompt assembly, not just once at setup.
#
# Usage: scripts/check-prompt-cache.sh [hours]   (default: last 2 hours)

set -euo pipefail

HOURS="${1:-2}"
DB="${COACHARTIE_DB:-/data2/apps/coachartie2/data/coachartie.db}"

if [ ! -f "$DB" ]; then
  echo "No DB at $DB (set COACHARTIE_DB to override)" >&2
  exit 1
fi

# The column is added at service boot (addColumnIfMissing in shared/db/client.ts). If the
# service hasn't started since the caching change shipped, say so rather than dying on a
# bare SQL error.
if ! sqlite3 "$DB" "PRAGMA table_info(model_usage_stats);" | grep -q '|cached_tokens|'; then
  echo "model_usage_stats has no cached_tokens column yet."
  echo "It is added on boot — start coach-artie-capabilities once, then re-run this."
  echo "To add it by hand:"
  echo "  sqlite3 $DB 'ALTER TABLE model_usage_stats ADD COLUMN cached_tokens INTEGER DEFAULT 0;'"
  exit 1
fi

echo "=== Prompt cache, last ${HOURS}h ==="
sqlite3 -header -column "$DB" "
  SELECT
    model_name,
    COUNT(*)                                             AS calls,
    ROUND(AVG(prompt_tokens))                            AS avg_in,
    ROUND(AVG(cached_tokens))                            AS avg_cached,
    ROUND(100.0 * SUM(cached_tokens) / NULLIF(SUM(prompt_tokens),0), 1) AS cache_pct,
    ROUND(SUM(estimated_cost), 4)                        AS cost
  FROM model_usage_stats
  WHERE timestamp > datetime('now', '-${HOURS} hours')
  GROUP BY model_name
  ORDER BY cost DESC;
"

echo
echo "=== Verdict ==="
# The FIRST call with a given prefix always writes (0% cached) — only judge from the second
# call onward, which is why this looks at the max rather than the average.
sqlite3 "$DB" "
  SELECT CASE
    WHEN COUNT(*) = 0
      THEN 'NO DATA — no calls in the window. Is he running? Are credits topped up?'
    WHEN MAX(cached_tokens) > 0
      THEN 'WORKING — best call served ' || MAX(cached_tokens) || ' tokens from cache.'
    ELSE 'NOT CACHING — every call billed its full prefix. Check, in this order: ' ||
         'is the model anthropic/*; is the static prefix above the model minimum ' ||
         '(Haiku 4.5 needs 4096, Opus 4.8 needs 1024 — grep the logs for ' ||
         '''Prompt cache: not applied''); did something dynamic get added ahead of the ' ||
         'breakpoint in context-alchemy''s system block (a date, a username, a channel name).'
  END
  FROM model_usage_stats
  WHERE timestamp > datetime('now', '-${HOURS} hours');
"

echo
echo "=== Prompt size trend (in:out ratio should be falling) ==="
sqlite3 -header -column "$DB" "
  SELECT date(timestamp) AS day,
         COUNT(*) AS calls,
         ROUND(AVG(prompt_tokens))   AS avg_in,
         ROUND(AVG(completion_tokens)) AS avg_out,
         ROUND(1.0*SUM(prompt_tokens)/NULLIF(SUM(completion_tokens),0)) AS ratio
  FROM model_usage_stats
  WHERE timestamp > datetime('now', '-14 days')
  GROUP BY day ORDER BY day DESC;
"
