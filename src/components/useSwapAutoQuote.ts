import { useEffect, useRef } from 'react'

export const SWAP_QUOTE_DEBOUNCE_MS = 700
// Leave headroom below the 30/minute IP firewall rule. This is per-tab pacing,
// not a shared-IP/global quota guarantee; Review Swap has its own fresh request.
export const SWAP_QUOTE_INTERVAL_MS = 2500

export function useSwapAutoQuote(key: string, enabled: boolean, load: () => Promise<void>, cancel: () => void) {
  const actions = useRef({ load, cancel })
  actions.current = { load, cancel }
  const currentKey = useRef(key)
  currentKey.current = key
  const lastStarted = useRef(-Infinity)
  useEffect(() => {
    const action = actions.current
    action.cancel()
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempted = false
    function schedule() {
      if (document.hidden || attempted) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.hidden || currentKey.current !== key) return
        attempted = true
        lastStarted.current = performance.now()
        void actions.current.load()
      }, Math.max(SWAP_QUOTE_DEBOUNCE_MS, SWAP_QUOTE_INTERVAL_MS - (performance.now() - lastStarted.current)))
    }
    function visibility() {
      if (document.hidden) { clearTimeout(timer); action.cancel() }
      else {
        // One fresh attempt per return, through the same debounce/pacing. No background polling or error retry loop.
        attempted = false
        schedule()
      }
    }
    document.addEventListener('visibilitychange', visibility)
    schedule()
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); action.cancel() }
  }, [key, enabled])
}
