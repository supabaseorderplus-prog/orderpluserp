"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../../config/supabase");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/', async (req, res, next) => {
    try {
        const partyId = req.query.party_id;
        if (!partyId) {
            return res.status(400).json({ success: false, message: 'party_id required' });
        }
        const { data: partyVerify, error: partyErr } = await supabase_1.supabaseAdmin
            .from('parties')
            .select('is_verified, company_id')
            .eq('id', partyId)
            .single();
        if (partyErr || !partyVerify) {
            return res.status(404).json({ success: false, message: 'Party not found' });
        }
        if (partyVerify.is_verified !== true) {
            return res.status(403).json({ success: false, message: 'Party must be verified to view credit analysis' });
        }
        const { data: invoices, error: invErr } = await supabase_1.supabaseAdmin
            .from('invoices')
            .select('id, invoice_number, invoice_date, due_date, grand_total, amount_paid, amount_outstanding, payment_status, is_cancelled')
            .eq('billing_party_id', partyId)
            .eq('status', 'ACTIVE')
            .is('is_cancelled', false)
            .order('invoice_date', { ascending: true });
        if (invErr)
            throw invErr;
        const { data: payments, error: payErr } = await supabase_1.supabaseAdmin
            .from('payments')
            .select('id, amount, payment_date')
            .eq('party_id', partyId)
            .eq('status', 'ACTIVE')
            .order('payment_date', { ascending: true });
        if (payErr)
            throw payErr;
        const allInvoices = (invoices || []);
        const allPayments = (payments || []);
        const nonCancelledInvoices = allInvoices.filter(inv => !inv.is_cancelled);
        if (nonCancelledInvoices.length === 0) {
            return res.json({
                success: true,
                data: {
                    party_id: partyId,
                    score: null,
                    band: null,
                    recommendation: 'No invoice history found. Cannot assess creditworthiness.',
                    score_components: null,
                    metrics: null,
                    yearly_breakdown: [],
                },
            });
        }
        const today = new Date();
        const totalInvoiced = nonCancelledInvoices.reduce((s, inv) => s + Number(inv.grand_total), 0);
        const totalPaid = nonCancelledInvoices.reduce((s, inv) => s + Number(inv.amount_paid), 0);
        const totalOutstanding = nonCancelledInvoices.reduce((s, inv) => s + Number(inv.amount_outstanding), 0);
        const paymentRate = totalInvoiced > 0 ? (totalPaid / totalInvoiced) * 100 : 0;
        const unpaidInvoices = nonCancelledInvoices.filter(inv => inv.payment_status === 'UNPAID' || inv.payment_status === 'PARTIAL');
        let avgOutstandingDays = 0;
        if (unpaidInvoices.length > 0) {
            const totalDays = unpaidInvoices.reduce((s, inv) => {
                const invDate = new Date(inv.invoice_date);
                const days = Math.max(0, Math.floor((today.getTime() - invDate.getTime()) / (1000 * 60 * 60 * 24)));
                return s + days;
            }, 0);
            avgOutstandingDays = totalDays / unpaidInvoices.length;
        }
        const firstInvoiceDate = new Date(nonCancelledInvoices[0].invoice_date);
        const monthsDiff = (today.getFullYear() - firstInvoiceDate.getFullYear()) * 12 +
            (today.getMonth() - firstInvoiceDate.getMonth()) + 1;
        const activeMonths = Math.max(1, monthsDiff);
        const monthsWithPayment = new Set(allPayments.map(p => {
            const d = new Date(p.payment_date);
            return `${d.getFullYear()}-${d.getMonth()}`;
        })).size;
        const paymentFrequency = Math.min(100, (monthsWithPayment / activeMonths) * 100);
        const avgMonthlyInvoiced = totalInvoiced / activeMonths;
        const totalPaymentsAmount = allPayments.reduce((s, p) => s + Number(p.amount), 0);
        const avgMonthlyPayment = totalPaymentsAmount / activeMonths;
        const paymentToInvoiceRatio = avgMonthlyInvoiced > 0 ? Math.min(100, (avgMonthlyPayment / avgMonthlyInvoiced) * 100) : 0;
        const twelveMonthsAgo = new Date(today);
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        const recentInvoices = nonCancelledInvoices.filter(inv => new Date(inv.invoice_date) >= twelveMonthsAgo);
        const recentPayments = allPayments.filter(p => new Date(p.payment_date) >= twelveMonthsAgo);
        const avgMonthlyInvoiceCount = recentInvoices.length / 12;
        const avgMonthlyPaymentCount = recentPayments.length / 12;
        const yearlyMap = new Map();
        for (const inv of nonCancelledInvoices) {
            const year = new Date(inv.invoice_date).getFullYear();
            const e = yearlyMap.get(year) || { invoiced: 0, paid: 0, invoice_count: 0, payment_count: 0, payment_amount: 0 };
            e.invoiced += Number(inv.grand_total);
            e.paid += Number(inv.amount_paid);
            e.invoice_count += 1;
            yearlyMap.set(year, e);
        }
        for (const p of allPayments) {
            const year = new Date(p.payment_date).getFullYear();
            const e = yearlyMap.get(year) || { invoiced: 0, paid: 0, invoice_count: 0, payment_count: 0, payment_amount: 0 };
            e.payment_count += 1;
            e.payment_amount += Number(p.amount);
            yearlyMap.set(year, e);
        }
        const yearlyBreakdown = Array.from(yearlyMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([year, d]) => ({
            year,
            ...d,
            payment_rate: d.invoiced > 0 ? Math.round((d.paid / d.invoiced) * 1000) / 10 : 0,
            avg_monthly_repayment: Math.round(d.payment_amount / 12),
        }));
        const yearsWithPayments = yearlyBreakdown.filter(y => y.payment_amount > 0);
        const yearlyAvgMonthlyRepayment = yearsWithPayments.length > 0
            ? Math.round(yearsWithPayments.reduce((s, y) => s + y.payment_amount / 12, 0) / yearsWithPayments.length)
            : 0;
        let score1 = 0;
        if (paymentRate >= 95)
            score1 = 40;
        else if (paymentRate >= 85)
            score1 = 34;
        else if (paymentRate >= 70)
            score1 = 26;
        else if (paymentRate >= 50)
            score1 = 16;
        else if (paymentRate >= 30)
            score1 = 8;
        else
            score1 = Math.max(0, (paymentRate / 30) * 8);
        let score2 = 0;
        if (unpaidInvoices.length === 0)
            score2 = 25;
        else if (avgOutstandingDays <= 30)
            score2 = 25;
        else if (avgOutstandingDays <= 60)
            score2 = 18;
        else if (avgOutstandingDays <= 90)
            score2 = 12;
        else if (avgOutstandingDays <= 180)
            score2 = 6;
        else
            score2 = 0;
        let score3 = 0;
        if (paymentFrequency >= 80)
            score3 = 20;
        else if (paymentFrequency >= 60)
            score3 = 15;
        else if (paymentFrequency >= 40)
            score3 = 10;
        else if (paymentFrequency >= 20)
            score3 = 5;
        else
            score3 = Math.max(0, (paymentFrequency / 20) * 5);
        let score4 = 0;
        if (paymentToInvoiceRatio >= 100)
            score4 = 15;
        else if (paymentToInvoiceRatio >= 80)
            score4 = 12;
        else if (paymentToInvoiceRatio >= 60)
            score4 = 8;
        else if (paymentToInvoiceRatio >= 40)
            score4 = 4;
        else
            score4 = Math.max(0, (paymentToInvoiceRatio / 40) * 4);
        const rawScore = Math.round(score1 + score2 + score3 + score4);
        const creditScore = Math.round(300 + (rawScore / 100) * 600);
        let band;
        if (creditScore >= 750)
            band = 'EXCELLENT';
        else if (creditScore >= 650)
            band = 'GOOD';
        else if (creditScore >= 550)
            band = 'FAIR';
        else if (creditScore >= 450)
            band = 'POOR';
        else
            band = 'VERY_POOR';
        const recommendation = band === 'EXCELLENT'
            ? 'Highly trustworthy. Safe to extend significant credit with standard terms.'
            : band === 'GOOD'
                ? 'Good payment history. Credit can be extended with normal terms.'
                : band === 'FAIR'
                    ? 'Moderate risk. Consider shorter credit periods or partial advance.'
                    : band === 'POOR'
                        ? 'High risk. Limit credit exposure and monitor closely.'
                        : 'Very high risk. Avoid extending credit or require full advance payment.';
        return res.json({
            success: true,
            data: {
                party_id: partyId,
                score: creditScore,
                raw_score: rawScore,
                band,
                recommendation,
                score_components: {
                    payment_rate: { score: Math.round(score1 * 10) / 10, max: 40, label: 'Payment Rate' },
                    outstanding_age: { score: Math.round(score2 * 10) / 10, max: 25, label: 'Outstanding Age' },
                    payment_frequency: { score: Math.round(score3 * 10) / 10, max: 20, label: 'Payment Frequency' },
                    payment_ratio: { score: Math.round(score4 * 10) / 10, max: 15, label: 'Payment-to-Invoice Ratio' },
                },
                metrics: {
                    total_invoices: nonCancelledInvoices.length,
                    total_invoiced: Math.round(totalInvoiced),
                    total_paid: Math.round(totalPaid),
                    total_outstanding: Math.round(totalOutstanding),
                    payment_rate: Math.round(paymentRate * 10) / 10,
                    avg_outstanding_days: Math.round(avgOutstandingDays),
                    payment_frequency: Math.round(paymentFrequency),
                    avg_monthly_invoiced: Math.round(avgMonthlyInvoiced),
                    avg_monthly_payment: Math.round(avgMonthlyPayment),
                    avg_monthly_repayment_yearly: yearlyAvgMonthlyRepayment,
                    avg_monthly_invoice_count: Math.round(avgMonthlyInvoiceCount * 10) / 10,
                    avg_monthly_payment_count: Math.round(avgMonthlyPaymentCount * 10) / 10,
                    active_months: activeMonths,
                    unpaid_invoice_count: unpaidInvoices.length,
                },
                yearly_breakdown: yearlyBreakdown,
            },
        });
    }
    catch (error) {
        console.error('Credit analysis error:', error);
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map