import { describe, expect, it } from 'vitest'

import { expenseHistoryAmounts } from '@/lib/expense-history-amounts'

describe('expenseHistoryAmounts', () => {
  it('uses the approved amount as the primary history value after a partial approval', () => {
    expect(expenseHistoryAmounts({
      status: 'APPROVED',
      requested_amount: 10,
      approved_amount: 5,
    })).toEqual({
      primaryAmount: 5,
      requestedAmount: 10,
    })
  })

  it('keeps the requested amount primary while a request is pending', () => {
    expect(expenseHistoryAmounts({
      status: 'PENDING',
      requested_amount: 10,
      approved_amount: null,
    })).toEqual({
      primaryAmount: 10,
      requestedAmount: null,
    })
  })
})
