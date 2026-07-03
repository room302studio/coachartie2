/**
 * Detect if a question is thoughtful/substantive and deserves token boost
 */
export function isThoughtfulQuestion(message: string): { isThoughtful: boolean; boostFactor: number } {
  if (!message || message.length < 30) {
    return { isThoughtful: false, boostFactor: 1 };
  }

  const text = message.toLowerCase();

  // Markers of thoughtful/substantive questions
  const depthMarkers = [
    'explain',
    'elaborate',
    'deeply',
    'profound',
    'complex',
    'nuanced',
    'trade-off',
    'tradeoff',
    'consider',
    'perspective',
    'implications',
    'implications',
    'thoughtfully',
    'carefully',
    'thoroughly',
    'comprehensive',
    'analysis',
    'understand',
    'reasoning',
    'why',
    'how would',
    'what if',
    'hypothetically',
  ];

  // Long, multi-part questions
  const hasMultipleParts = (message.match(/\?/g) || []).length >= 2;

  // Builds on context (referencing prior discussion)
  const contextMarkers = ['you said', 'earlier', 'before', 'like you mentioned', 'building on'];
  const buildingOnContext = contextMarkers.some(marker => text.includes(marker));

  // Technical depth
  const technicalMarkers = [
    'algorithm',
    'architecture',
    'optimize',
    'performance',
    'edge case',
    'reliability',
    'scalability',
  ];
  const isTechnical = technicalMarkers.some(marker => text.includes(marker));

  // Score thoughtfulness
  let score = 0;
  score += depthMarkers.filter(marker => text.includes(marker)).length > 2 ? 2 : 0;
  score += hasMultipleParts ? 1.5 : 0;
  score += buildingOnContext ? 1.5 : 0;
  score += isTechnical ? 1 : 0;
  score += message.length > 200 ? 1 : 0; // Longer messages tend to be more thoughtful

  const isThoughtful = score >= 2;
  const boostFactor = isThoughtful ? Math.min(1.5, 1 + score * 0.15) : 1; // Up to 1.5x boost

  return { isThoughtful, boostFactor };
}
