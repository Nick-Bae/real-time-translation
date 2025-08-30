// frontend/utils/useClauseCommit.ts
import { useCallback, useRef } from 'react'
import { d, g, pv } from './debug'

type Handlers = {
  onPartial?: (t: string) => void
  onCommit?: (chunk: { id: number; rev: number; text: string; final: boolean }) => void
}

type Cfg = {
  forceAfterMs?: number          // normal force timeout
  connectiveForceAfterMs?: number// extra wait if ends with -면/-다면/-는데…
  vadSilenceMs?: number          // how long with no interim changes counts as "pause"
  minChunkChars?: number         // minimum chars for any non-final commit
  minFirstCommitChars?: number   // stricter first commit within a segment
}

const END_PUNCT = /[.!?…‥!?]|[。！？」］]/
const SOFT_PUNCT = /[,،、·]/

// polite/final endings (commit-friendly)
const COMMIT_ENDINGS = /(습니다|ㅂ니다|였(다|어요?)|했(다|어요?)|합니다|죠|네요|랍니다|라구요|에요|예요|요|않다)\s*$/

// connective endings we prefer to hold briefly
// expand connective endings
const HOLD_ENDINGS =
  /(기\s*때문에|때문에|다면|면|으면|는데|는데요?|지만|려고|면서|다가|자마자|거나|거든|라서|아서|어서|니까|으니까|며|으며)\s*$/;

// adverbs we should not force-commit after
const ADVERB_TAIL =
  /(정말|진짜|아주|매우|너무|대단히|굉장히|열심히|잘|많이|조금|약간)$/;

// if ending directly on these particles, be suspicious (hold a bit longer)
const PARTICLE_TAIL = /(은|는|이|가|을|를|에|에서|에게|께|로|으로|와|과|도|만|까지|부터|처럼|같이)$/

function normalizeWS(s: string) {
  return s.replace(/\s+/g, ' ').trim();
}
function startsWithLoose(full: string, prefix: string) {
  // compare ignoring multiple spaces
  const f = normalizeWS(full);
  const p = normalizeWS(prefix);
  // quick path: if clear mismatch, bail
  if (p.length === 0) return false;
  if (f === p) return true;
  // strict startsWith on the normalized strings
  return f.startsWith(p);
}
function stripCommittedPrefix(interim: string, lastCommitted: string) {
  if (!lastCommitted) return interim;
  // Fast path: exact prefix
  if (interim.startsWith(lastCommitted)) {
    return interim.slice(lastCommitted.length).replace(/^\s+/, '');
  }
  // Loose path: ignore whitespace differences
  if (startsWithLoose(interim, lastCommitted)) {
    // Find where the committed prefix ends in the original interim by length
    const want = normalizeWS(lastCommitted).length;
    let seen = 0;
    for (let i = 0; i < interim.length; i++) {
      const ch = interim[i];
      const add = /\s/.test(ch) ? (seen > 0 && interim[i - 1] !== ' ' ? 1 : 0) : 1;
      seen += add;
      if (seen >= want) {
        return interim.slice(i + 1).replace(/^\s+/, '');
      }
    }
  }
  return interim;
}

function findBoundary(text: string): { cut: number; reason?: string } {
  // Hard punctuation
  if (END_PUNCT.test(text)) {
    const idx = Math.max(
      text.lastIndexOf('!'),
      text.lastIndexOf('?'),
      text.lastIndexOf('…'),
      text.lastIndexOf('.'),
      text.lastIndexOf('。')
    )
    return { cut: idx >= 0 ? idx + 1 : -1, reason: 'punct' }
  }
  // Polite/final endings (only if not connective)
  if (!HOLD_ENDINGS.test(text)) {
    const m = text.match(COMMIT_ENDINGS)
    if (m && m.index !== undefined) return { cut: m.index + m[0].length, reason: 'final-ending' }
  }
  // Soft punctuation (comma-like) → only if tail after comma is longish
  if (SOFT_PUNCT.test(text)) {
    const idx = Math.max(text.lastIndexOf(','), text.lastIndexOf('、'), text.lastIndexOf('·'))
    if (idx >= 0 && text.length - (idx + 1) >= 8) return { cut: idx + 1, reason: 'soft-punct' }
  }
  return { cut: -1 }
}

export function useClauseCommit(handlers: Handlers, cfg: Cfg = {}) {
  // Config (stable defaults)
  const forceAfterMs = cfg.forceAfterMs ?? 1400
  const connectiveForceAfterMs = cfg.connectiveForceAfterMs ?? 2300
  const vadSilenceMs = cfg.vadSilenceMs ?? 420
  const minChunkChars = cfg.minChunkChars ?? 12
  const minFirstCommitChars = cfg.minFirstCommitChars ?? 16

  // State refs
  const bufRef = useRef('')                      // rolling interim buffer
  const lastChangeAtRef = useRef<number>(performance.now())
  const bufferStartAtRef = useRef<number>(performance.now())
  const segIdRef = useRef(1)
  const revRef = useRef(0)

  // De-dupe refs
  const lastPartialSentRef = useRef('')          // last partial we emitted
  const lastCommitStrRef = useRef('')            // last committed text
  const lastCommitAtRef = useRef(0)              // timestamp of last commit

  const now = () => performance.now()

  const emitCommit = useCallback((text: string, final = false, why = '') => {
    const clean = text.trim()
    if (!clean) return

    // Skip duplicate non-final commits
    if (!final && clean === lastCommitStrRef.current) {
      d('skip', `dup-commit "${pv(clean)}"`)
      return
    }

    const id = segIdRef.current
    const rev = ++revRef.current
    d('commit', `${why} → id=${id} rev=${rev} final=${final} len=${clean.length} text="${pv(clean)}"`)
    handlers.onCommit?.({ id, rev, text: clean, final })

    lastCommitStrRef.current = clean
    lastCommitAtRef.current = now()
  }, [handlers])

  const feedInterim = useCallback((t: string) => {
    const raw = t || '';
    const trimmedFull = raw.replace(/\s+/g, ' ').trim();
    if (!trimmedFull) return;

    // ✅ remove the portion we've already committed in this segment
    const committed = lastCommitStrRef.current || '';
    let trimmed = trimmedFull;
    if (committed) {
      const newTail = stripCommittedPrefix(trimmedFull, committed);
      if (newTail !== trimmedFull) {
        d('trim', `stripped committed prefix oldLen=${trimmedFull.length} → newLen=${newTail.length}`);
        trimmed = newTail;
      }
    }

    // If buffer already equals the (possibly stripped) interim, skip
    if (trimmed === bufRef.current) return;

    const wasEmpty = bufRef.current.length === 0;
    bufRef.current = trimmed;

    const tNow = now();
    lastChangeAtRef.current = tNow;
    if (wasEmpty && trimmed) bufferStartAtRef.current = tNow;

    // Only emit partial if changed from the previous one we sent
    if (trimmed !== lastPartialSentRef.current) {
      d('partial', `bufLen=${trimmed.length} seg=${segIdRef.current} rev=${revRef.current} text="${pv(trimmed)}"`);
      lastPartialSentRef.current = trimmed;
      handlers.onPartial?.(trimmed);
    } else {
      d('skip', `same-partial "${pv(trimmed)}"`);
    }
  }, [handlers]);


  // Finals always commit (even if short). Non-final "forced" commits respect minChunkChars.
  const forceCommitFinal = useCallback((final: boolean, why = 'force') => {
    const text = bufRef.current.trim()

    if (final) {
      if (text) {
        emitCommit(text, true, why)     // ✅ always send finals
      } else {
        d('skip', `${why} final but empty`)
      }
      // new segment
      segIdRef.current += 1
      revRef.current = 0
      bufRef.current = ''
      const tNow = now()
      lastChangeAtRef.current = tNow
      bufferStartAtRef.current = tNow
      lastPartialSentRef.current = ''   // safe to clear for next segment
      d('segment', `→ new seg id=${segIdRef.current}`)
      return
    }

    // Non-final forced commit (respect size guard)
    if (text.length >= minChunkChars) {
      emitCommit(text, false, why)
      const tNow = now()
      lastChangeAtRef.current = tNow
      bufferStartAtRef.current = tNow
    } else {
      d('skip', `${why} too-short len=${text.length} min=${minChunkChars} text="${pv(text)}"`)
    }
  }, [emitCommit, minChunkChars])

  const feedFinal = useCallback((t: string) => {
    g('asr-final', 'text', t)
    feedInterim(t)                  // keep buffer in sync
    forceCommitFinal(true, 'asr-final')
  }, [feedInterim, forceCommitFinal])

  const tick = useCallback(() => {
    const text = bufRef.current
    if (!text) return

    const tNow = now()
    const sinceChange = tNow - lastChangeAtRef.current
    const sinceStart = tNow - bufferStartAtRef.current

    const { cut, reason } = findBoundary(text)

    const lastToken = (text.split(/\s+/).pop() || '').trim()
    const isHangulOnly = /^[\uAC00-\uD7AF]+$/.test(lastToken)
    const looksLikeVerbStub = isHangulOnly && lastToken.length <= 2
    const endsOnParticle = PARTICLE_TAIL.test(lastToken)
    const endsWithConnective = HOLD_ENDINGS.test(text)

    const pauseDetected = sinceChange >= vadSilenceMs
    const ageOkNormal = pauseDetected && sinceStart >= forceAfterMs
    const ageOkConnective = pauseDetected && sinceStart >= connectiveForceAfterMs

    const endsOnAdverb = ADVERB_TAIL.test(lastToken);

    let shouldForce = ageOkNormal && text.length >= minChunkChars
    let forceWhy = `force pause sinceStart=${sinceStart.toFixed(0)}ms`

    // First commit stricter unless we hit a boundary
    if (revRef.current === 0 && cut < 0 && text.length < minFirstCommitChars) {
      shouldForce = false
    }

    // If clearly connective, allow a longer timeout force
    if (!shouldForce && endsWithConnective && text.length >= minFirstCommitChars && ageOkConnective) {
      shouldForce = true
      forceWhy = `timeout-connective sinceStart=${sinceStart.toFixed(0)}ms`
    }

    // Particles/verb stubs: hold unless we already waited the longer timeout
    if (shouldForce && (endsOnParticle || endsOnAdverb || looksLikeVerbStub) && sinceStart < connectiveForceAfterMs) {
      shouldForce = false
    }

    if (cut > 0 && cut >= minChunkChars) {
      const left = text.slice(0, cut).trim()
      const right = text.slice(cut).trim()
      emitCommit(left, false, `boundary:${reason} sinceStart=${sinceStart.toFixed(0)}ms`)
      bufRef.current = right
      bufferStartAtRef.current = tNow
      lastChangeAtRef.current = tNow
      lastPartialSentRef.current = '' // allow new partials for the tail
      if (right) d('carry', `tailLen=${right.length} text="${pv(right)}"`)
      return
    }

    if (shouldForce) {
      emitCommit(text.trim(), false, forceWhy)
      bufRef.current = ''
      bufferStartAtRef.current = tNow
      lastChangeAtRef.current = tNow
      lastPartialSentRef.current = ''
      return
    }
  }, [
    emitCommit,
    minChunkChars,
    vadSilenceMs,
    forceAfterMs,
    connectiveForceAfterMs,
    minFirstCommitChars
  ])

  const reset = useCallback(() => {
    bufRef.current = ''
    revRef.current = 0
    const tNow = now()
    lastChangeAtRef.current = tNow
    bufferStartAtRef.current = tNow
    lastPartialSentRef.current = ''
    // Intentionally DO NOT clear lastCommitStrRef here — helps suppress refills of same text
    d('reset', `seg=${segIdRef.current} cleared buffer`)
  }, [])

  return { feedInterim, feedFinal, tick, reset }
}
