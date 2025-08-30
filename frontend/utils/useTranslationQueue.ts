// utils/useTranslationQueue.ts
import { useRef, useState, useCallback } from 'react'

type Job = { id: number; text: string }
type ResultCb = (original: string, translated: string) => void

export function useTranslationQueue(
  translateNow: (text: string) => Promise<string>,
  { concurrency = 2 } = {}
) {
  const q = useRef<Job[]>([])
  const inFlight = useRef(0)
  const nextId = useRef(1)
  const [pending, setPending] = useState(0)
  

  const pump = useCallback(() => {
    while (inFlight.current < concurrency && q.current.length) {
      const job = q.current.shift()!
      inFlight.current++
      translateNow(job.text)
        .then((out) => {
          // fire an event or state update in caller
          document.dispatchEvent(new CustomEvent('translated', { detail: { original: job.text, translated: out }}))
        })
        .finally(() => {
          inFlight.current--
          setPending(q.current.length)
          pump()
        })
    }
  }, [concurrency, translateNow])

  const enqueue = useCallback((text: string) => {
    q.current.push({ id: nextId.current++, text })
    setPending(q.current.length)
    pump()
  }, [pump])

  return { enqueue, pending }
}
