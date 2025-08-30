import { useCallback } from 'react'
import { useTranslationSocket as useLongSocket } from './useTranslationSocket' // your long hook

type Adapter = {
  connected: boolean
  last: any
  sendProducerText: (
    text: string,
    source: string,
    target: string,
    partial?: boolean,
    segmentId?: number,
    rev?: number
  ) => void
}

export function useTranslationSocketAdapter(): Adapter {
  // Cast to any so TS doesn’t complain about unknown props on your long hook
  const s = useLongSocket() as any

  // best-effort "connected" detection
  const connected: boolean = !!(
    (typeof s?.connected === 'boolean' && s.connected) ||
    (typeof s?.isOpen === 'boolean' && s.isOpen) ||
    (typeof s?.ready === 'boolean' && s.ready) ||
    (s?.ws && s.ws.readyState === 1)
  )

  // pick a "last message" field if available
  const last =
    (s?.lastMessage !== undefined ? s.lastMessage : undefined) ??
    (s?.last !== undefined ? s.last : undefined) ??
    (s?.message !== undefined ? s.message : undefined) ??
    null

  const sendProducerText = useCallback((
    text: string,
    source: string,
    target: string,
    partial = false,
    segmentId?: number,
    rev?: number
  ) => {
    const payload = { type: 'producer_text', text, source, target, partial, segmentId, rev }

    // Prefer your hook’s own method if it exists
    if (typeof s?.sendProducerText === 'function') {
      s.sendProducerText(text, source, target, partial, segmentId, rev)
      return
    }

    // Generic send methods (shape-agnostic)
    if (typeof s?.send === 'function') {
      try {
        s.send(JSON.stringify(payload))
      } catch {
        // if your send expects an object
        s.send(payload)
      }
      return
    }

    if (typeof s?.publish === 'function') {
      s.publish('translate', payload)
      return
    }

    if (s?.ws && typeof s.ws.send === 'function') {
      s.ws.send(JSON.stringify(payload))
      return
    }

    // No-op fallback (nothing to send to)
  }, [s])

  return { connected, last, sendProducerText }
}
