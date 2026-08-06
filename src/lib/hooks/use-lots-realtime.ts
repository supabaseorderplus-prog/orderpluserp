import { useCallback, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { api } from '@/lib/api'
import { useVisibleInterval } from '@/lib/hooks/use-visible-interval'

const POLL_MS = 60_000
export const LOTS_CHANGED_EVENT = 'hometech:delivery-lots-changed'
const LOTS_CHANNEL = 'hometech-delivery-lots'

/**
 * Keeps delivery lots in sync across every device, account, and browser tab.
 *
 * Sync layers, cheapest first:
 *   1. Supabase Realtime on the two lot tables — instant, push-based, no polling.
 *   2. BroadcastChannel + a window event — same-device tabs, zero network.
 *   3. A 60s fallback poll against /api/v1/delivery-lots/version — covers the case
 *      where Realtime replication isn't enabled or the socket silently dropped.
 *
 * The fallback deliberately polls the *version* endpoint, not the list: it returns
 * a row count plus the newest updated_at, so a poll that finds no change costs a
 * few bytes instead of the full lot list. The earlier version of this hook polled
 * the full list every 3 seconds, which was the single largest contributor to the
 * 18 GB Supabase egress overage that got the project restricted. Do not lower
 * POLL_MS or point the poll back at the list endpoint.
 */
export function useLotsRealtime(onRefresh: () => void) {
  // Store in a ref so the subscription never needs to restart when the
  // parent component re-renders and produces a new function reference.
  const cbRef = useRef(onRefresh)
  cbRef.current = onRefresh

  // Last version seen from the server. `undefined` = not probed yet.
  const lastVersionRef = useRef<string | null | undefined>(undefined)

  const probeVersion = useCallback(async (): Promise<string | null> => {
    try {
      const res = await api<{ version: string | null }>('/api/v1/delivery-lots/version', {
        noCache: true,
        suppressErrorLog: true,
      })
      return res.version ?? null
    } catch {
      return null
    }
  }, [])

  // Refresh now (push-driven), then re-sync the version so the next poll doesn't
  // see the change we just pulled and fetch the whole list a second time.
  const refreshAndSync = useCallback(() => {
    cbRef.current()
    void probeVersion().then((version) => {
      lastVersionRef.current = version
    })
  }, [probeVersion])

  useEffect(() => {
    // Primary: Supabase postgres_changes — fires instantly on INSERT / UPDATE / DELETE
    // (requires the delivery_lots tables to be in the Supabase realtime publication).
    //
    // Note: company_notes is NOT subscribed to. It is a shared fallback store for
    // invoice requests, group membership, approval markers and tokens, so a wildcard
    // subscription on it made every unrelated write anywhere in the app fan out a
    // full lot refetch to every connected device.
    const channel = supabase
      .channel('delivery-lots-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_lots' },
        refreshAndSync,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_lot_orders' },
        refreshAndSync,
      )
      .subscribe()

    // Same-browser tabs update immediately too, without waiting for the
    // websocket or the polling fallback.
    const broadcast = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(LOTS_CHANNEL)
      : null
    broadcast?.addEventListener('message', refreshAndSync)
    window.addEventListener(LOTS_CHANGED_EVENT, refreshAndSync)

    // Seed the version from the server so the first poll compares against a real
    // value instead of `undefined` and refetches the list for no reason. The page
    // does its own initial load, so this must not trigger onRefresh.
    void probeVersion().then((version) => {
      lastVersionRef.current = version
    })

    return () => {
      supabase.removeChannel(channel)
      broadcast?.removeEventListener('message', refreshAndSync)
      broadcast?.close()
      window.removeEventListener(LOTS_CHANGED_EVENT, refreshAndSync)
    }
  }, [refreshAndSync, probeVersion])

  // Fallback: poll the cheap version endpoint and only pull the full list when it
  // actually moved. useVisibleInterval pauses this while the tab is hidden and
  // fires once immediately when it comes back into view.
  useVisibleInterval(
    useCallback(() => {
      void probeVersion().then((version) => {
        // A null version means the server couldn't determine one. Refresh rather
        // than risk showing stale lots — a wrong lot list is worse than a fetch.
        if (version === null || version !== lastVersionRef.current) {
          lastVersionRef.current = version
          cbRef.current()
        }
      })
    }, [probeVersion]),
    POLL_MS,
  )
}

export function announceLotsChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(LOTS_CHANGED_EVENT))
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(LOTS_CHANNEL)
    channel.postMessage({ changedAt: Date.now() })
    channel.close()
  }
}
