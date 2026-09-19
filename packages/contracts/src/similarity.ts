import { lowerWords } from './text.js';

export interface SourceCopySignal {
  example_id: string;
  /** Longest run of consecutive shared words. */
  longest_shared_run: number;
  /** Share of the transcript's 6-word shingles that also occur in the example. */
  shingle_overlap: number;
}

export interface SourceCopyResult {
  flagged: boolean;
  /** Best-matching example, if any overlap was found. */
  best: SourceCopySignal | null;
  signals: SourceCopySignal[];
}

const SHINGLE = 6;
const RUN_THRESHOLD = 10;
const OVERLAP_THRESHOLD = 0.4;

function shingles(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i += 1) out.add(tokens.slice(i, i + n).join(' '));
  return out;
}

function longestSharedRun(a: string[], b: string[]): number {
  // Classic DP on token arrays; inputs are short (a few hundred tokens).
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
        if ((cur[j] ?? 0) > best) best = cur[j] ?? 0;
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * Flags a transcript that likely reproduces a source example. Similarity is a
 * label that invites clarification, not proof of dishonesty. Critiquing a
 * source (quoting a fragment) produces lower overlap than reciting it; the
 * thresholds are tuned so the 20 supplied examples recited verbatim flag and
 * ordinary original answers do not.
 */
export function detectSourceCopy(
  transcript: string,
  examples: ReadonlyArray<{ example_id: string; text_verbatim: string }>,
): SourceCopyResult {
  const t = lowerWords(transcript);
  const tShingles = shingles(t, SHINGLE);
  const signals: SourceCopySignal[] = [];
  for (const ex of examples) {
    const e = lowerWords(ex.text_verbatim);
    const run = longestSharedRun(t, e);
    let overlap = 0;
    if (tShingles.size > 0) {
      const eShingles = shingles(e, SHINGLE);
      let shared = 0;
      for (const s of tShingles) if (eShingles.has(s)) shared += 1;
      overlap = shared / tShingles.size;
    }
    if (run > 0) signals.push({ example_id: ex.example_id, longest_shared_run: run, shingle_overlap: overlap });
  }
  signals.sort((a, b) => b.longest_shared_run - a.longest_shared_run || b.shingle_overlap - a.shingle_overlap);
  const best = signals[0] ?? null;
  const flagged = best !== null && (best.longest_shared_run >= RUN_THRESHOLD || best.shingle_overlap >= OVERLAP_THRESHOLD);
  return { flagged, best, signals };
}
