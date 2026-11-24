/**
 * Does a message look like someone talking about their GitHub activity? Gates the
 * identity-resolver import + DB lookup in on-message's raw-log step, so it should be
 * cheap and not fire on ordinary words.
 *
 * Ledger #3: the old pattern had no word boundaries, so "pr" matched "problem", "issue"
 * matched "tissue" and "commit" matched "committee". Every alternative is whole-word now,
 * with the common inflections spelled out ("pushed", "commits", "PRs", "merged", ...).
 */
const GITHUB_SIGNALS_RE =
  /\b(?:push(?:ed|es|ing)?|commit(?:s|ted|ting)?|prs?|pull requests?|issues?|merg(?:e|ed|es|ing)|branch(?:es)?|github|i opened|i filed)\b/i;

export function looksLikeGithubActivity(text: string): boolean {
  return GITHUB_SIGNALS_RE.test(text);
}
