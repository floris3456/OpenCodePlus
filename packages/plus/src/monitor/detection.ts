/** Numeric cache detection. Explanations, fingerprints and facts cannot alter this result. */
export function detectCache(input: {
  reported: boolean
  input?: number
  read?: number
  predecessor: boolean
  frontier?: number
}) {
  if (!input.reported) return { verdict: "none" as const, missTokens: 0 }
  if (!input.predecessor) return { verdict: "cold" as const, missTokens: 0 }
  const baseline = input.frontier === undefined || input.input === undefined
    ? undefined : Math.min(input.frontier, input.input)
  if (input.read === undefined || (baseline === undefined && (input.input === undefined || input.read <= input.input - 128)))
    return { verdict: "unknown" as const, baseline, missTokens: 0 }
  const shortfall = baseline === undefined || input.read === undefined ? 0 : Math.max(0, baseline - input.read)
  return {
    verdict: shortfall >= 128 ? input.read === 0 ? "miss" as const : "partial" as const : "hit" as const,
    baseline,
    missTokens: shortfall >= 128 ? shortfall : 0,
  }
}
