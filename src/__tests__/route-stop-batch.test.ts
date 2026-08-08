import { describe, expect, it } from 'vitest'
import { prepareRouteStopIds } from '@/lib/route-stop-batch'

describe('prepareRouteStopIds', () => {
  it('preserves group order while skipping deleted party references', () => {
    expect(
      prepareRouteStopIds(['party-2', 'deleted-party', 'party-1'], ['party-1', 'party-2']),
    ).toEqual({
      validIds: ['party-2', 'party-1'],
      skippedIds: ['deleted-party'],
    })
  })

  it('deduplicates IDs and ignores invalid input values', () => {
    expect(
      prepareRouteStopIds(['party-1', 'party-1', '', null, 12], ['party-1']),
    ).toEqual({ validIds: ['party-1'], skippedIds: [] })
  })
})
