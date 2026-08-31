import type { ExpenseStatus } from '@/lib/expenses-fallback'

type ExpenseHistoryAmountInput = {
  status: ExpenseStatus
  requested_amount: number
  approved_amount: number | null
}

export function expenseHistoryAmounts(expense: ExpenseHistoryAmountInput): {
  primaryAmount: number
  requestedAmount: number | null
} {
  const requestedAmount = Number(expense.requested_amount) || 0

  if (expense.status !== 'APPROVED') {
    return { primaryAmount: requestedAmount, requestedAmount: null }
  }

  const parsedApprovedAmount = expense.approved_amount == null
    ? requestedAmount
    : Number(expense.approved_amount)
  const approvedAmount = Number.isFinite(parsedApprovedAmount)
    ? parsedApprovedAmount
    : requestedAmount

  return {
    primaryAmount: approvedAmount,
    requestedAmount: approvedAmount === requestedAmount ? null : requestedAmount,
  }
}
