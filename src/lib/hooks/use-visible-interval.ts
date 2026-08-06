import { useEffect, useRef } from 'react'

/**
 * Runs `callback` every `intervalMs` — but ONLY while the document is visible.
 *
 * Polling screens (orders, dashboard, rankings, tracking) refresh every 15-30s.
 * When the tab is backgrounded or the Android app is minimised, that polling
 * keeps hammering the API for data nobody is looking at; multiplied across many
 * users it is a constant background load that competes with foreground requests
 * and is a real contributor to "everything is slow when lots of people are on".
 *
 * This hook pauses the interval when the page is hidden and fires `callback` once
 * immediately when it becomes visible again, so the user never sees stale data on
 * resume. The callback is held in a ref, so changing its identity (e.g. when a
 * filter changes) does not tear down and restart the timer. Pass intervalMs <= 0
 * to disable polling entirely.
 */
export function useVisibleInterval(callback: () => void, intervalMs: number): void {
  const savedCallback = useRef(callback)
  useEffect(() => {
    savedCallback.current = callback
  }, [callback])

  useEffect(() => {
    if (!intervalMs || intervalMs <= 0) return
    if (typeof document === 'undefined') return

    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer) return
      timer = setInterval(() => savedCallback.current(), intervalMs)
    }
    const stop = () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop()
      } else {
        savedCallback.current()
        start()
      }
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      stop()
    }
  }, [intervalMs])
}
