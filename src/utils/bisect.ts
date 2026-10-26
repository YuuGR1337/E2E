/**
 * Binary search for the commit that broke a test, the way `git bisect`
 * does it, over a list of commits ordered oldest first. The commit before
 * the list is known good and the last one is known bad. A commit that
 * cannot be tested (the test does not exist yet, the project does not
 * build) is skipped; when skips leave no commit to try, the answer is the
 * range the first bad commit is in.
 */

export type BisectVerdict = 'good' | 'bad' | 'skip';

export interface BisectStep {
  commit: string;
  verdict: BisectVerdict;
  /** Why the commit was bad or skipped, in one line. */
  note?: string;
}

export interface BisectOutcome {
  /** The first bad commit, when the search narrowed it to one. */
  firstBad?: string;
  /** Otherwise the commits it is among, oldest first. */
  range: string[];
  steps: BisectStep[];
  /** The search stopped at maxSteps or on cancel before it finished. */
  stopped?: 'max-steps' | 'cancelled';
}

export async function bisectCommits(
  commits: readonly string[],
  check: (commit: string) => Promise<{ verdict: BisectVerdict; note?: string }>,
  options: { maxSteps?: number; signal?: AbortSignal } = {},
): Promise<BisectOutcome> {
  const steps: BisectStep[] = [];
  const skipped = new Set<number>();
  let good = -1;
  let bad = commits.length - 1;
  const maxSteps = options.maxSteps ?? 20;
  let stopped: BisectOutcome['stopped'];

  while (bad - good > 1) {
    if (options.signal?.aborted) {
      stopped = 'cancelled';
      break;
    }
    if (steps.length >= maxSteps) {
      stopped = 'max-steps';
      break;
    }
    const middle = (good + bad) / 2;
    let pick = -1;
    for (let i = good + 1; i < bad; i += 1) {
      if (skipped.has(i)) continue;
      if (pick < 0 || Math.abs(i - middle) < Math.abs(pick - middle)) pick = i;
    }
    if (pick < 0) break;
    const { verdict, note } = await check(commits[pick]);
    steps.push({ commit: commits[pick], verdict, ...(note ? { note } : {}) });
    if (verdict === 'good') good = pick;
    else if (verdict === 'bad') bad = pick;
    else skipped.add(pick);
  }
  const range = commits.slice(good + 1, bad + 1);
  return { ...(range.length === 1 ? { firstBad: range[0] } : {}), range, steps, ...(stopped ? { stopped } : {}) };
}
