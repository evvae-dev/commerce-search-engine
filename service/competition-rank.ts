export function competitionRanks(scores: number[]): number[] {
  const firstRankByScore = new Map<number, number>();
  return scores.map((score, index) => {
    const existingRank = firstRankByScore.get(score);
    if (existingRank !== undefined) return existingRank;
    const rank = index + 1;
    firstRankByScore.set(score, rank);
    return rank;
  });
}
