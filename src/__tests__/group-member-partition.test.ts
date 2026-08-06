import { describe, test, expect } from 'vitest'
import { partitionRequestedMembers } from '@/lib/groups'

// Real ids from the production tree, so these assertions describe the exact situation
// that emptied the Murshidabad groups rather than a synthetic stand-in.
const IN_SCOPE_A = 'bapi-builders-rejinagar-msd'
const IN_SCOPE_B = 'badsha-builders-debo-gram-nadia'
const DANGLING_MEMBER = '172272de-51fc-4db2-8b50-fd0719e0757d' // stored member, party row hard-deleted
const OTHER_COMPANY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('partitionRequestedMembers', () => {
  test('accepts ids that resolve inside the company tree', () => {
    const scope = new Set([IN_SCOPE_A, IN_SCOPE_B])
    const { valid, rejected } = partitionRequestedMembers([IN_SCOPE_A, IN_SCOPE_B], [], scope)
    expect(valid).toEqual([IN_SCOPE_A, IN_SCOPE_B])
    expect(rejected).toEqual([])
  })

  test('rejects a party outside the company instead of silently dropping it', () => {
    const scope = new Set([IN_SCOPE_A])
    const { valid, rejected } = partitionRequestedMembers([IN_SCOPE_A, OTHER_COMPANY], [], scope)
    expect(valid).toEqual([IN_SCOPE_A])
    expect(rejected).toEqual([OTHER_COMPANY])
  })

  test('retains an existing member whose party row no longer resolves in scope', () => {
    const scope = new Set([IN_SCOPE_A])
    const { valid, rejected } = partitionRequestedMembers(
      [IN_SCOPE_A, DANGLING_MEMBER],
      [DANGLING_MEMBER],
      scope,
    )
    expect(valid).toContain(DANGLING_MEMBER)
    expect(rejected).toEqual([])
  })

  // The regression that emptied GRP-0013/0014/0015: the scope lookup degraded (truncated
  // RPC / failed party scan), so every selected party fell outside it. The old code saved
  // the empty remainder. Existing members must survive; genuinely new ids must be refused
  // loudly so the save aborts rather than persisting a smaller group.
  test('a degraded scope cannot silently wipe a group', () => {
    const existing = [IN_SCOPE_A, IN_SCOPE_B]
    const degradedScope = new Set<string>(['company-root-only'])
    const { valid, rejected } = partitionRequestedMembers(existing, existing, degradedScope)
    expect(valid).toEqual(existing)
    expect(rejected).toEqual([])
  })

  test('a degraded scope refuses new additions rather than dropping them', () => {
    const degradedScope = new Set<string>(['company-root-only'])
    const { valid, rejected } = partitionRequestedMembers([IN_SCOPE_A, IN_SCOPE_B], [IN_SCOPE_A], degradedScope)
    expect(valid).toEqual([IN_SCOPE_A])
    expect(rejected).toEqual([IN_SCOPE_B])
  })

  test('a null scope (unscoped SUPER_ADMIN) allows everything', () => {
    const { valid, rejected } = partitionRequestedMembers([IN_SCOPE_A, OTHER_COMPANY], [], null)
    expect(valid).toEqual([IN_SCOPE_A, OTHER_COMPANY])
    expect(rejected).toEqual([])
  })

  test('deduplicates and drops empty ids', () => {
    const scope = new Set([IN_SCOPE_A])
    const { valid } = partitionRequestedMembers([IN_SCOPE_A, IN_SCOPE_A, ''], [], scope)
    expect(valid).toEqual([IN_SCOPE_A])
  })
})
