"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGstPercent = getGstPercent;
exports.calculateGst = calculateGst;
exports.generateOrderNumber = generateOrderNumber;
exports.generateInvoiceNumber = generateInvoiceNumber;
exports.getCurrentFiscalYear = getCurrentFiscalYear;
exports.formatIndianCurrency = formatIndianCurrency;
const GST_RATE_MAP = {
    GST_5: 5,
    GST_12: 12,
    GST_18: 18,
    GST_28: 28,
};
function getGstPercent(rate) {
    return GST_RATE_MAP[rate];
}
function calculateGst(amount, gstRate, isInterstate = false) {
    const taxableAmount = typeof amount === 'number' ? amount : Number(amount);
    const ratePercent = getGstPercent(gstRate);
    const totalTax = (taxableAmount * ratePercent) / 100;
    if (isInterstate) {
        return {
            taxableAmount,
            cgstRate: 0,
            cgstAmount: 0,
            sgstRate: 0,
            sgstAmount: 0,
            igstRate: ratePercent,
            igstAmount: round2(totalTax),
            totalTax: round2(totalTax),
            totalWithTax: round2(taxableAmount + totalTax),
            isInterstate: true,
        };
    }
    const halfRate = ratePercent / 2;
    const halfTax = totalTax / 2;
    return {
        taxableAmount,
        cgstRate: halfRate,
        cgstAmount: round2(halfTax),
        sgstRate: halfRate,
        sgstAmount: round2(halfTax),
        igstRate: 0,
        igstAmount: 0,
        totalTax: round2(totalTax),
        totalWithTax: round2(taxableAmount + totalTax),
        isInterstate: false,
    };
}
function round2(num) {
    return Math.round(num * 100) / 100;
}
function generateOrderNumber(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const rand = String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0');
    return `HTC-${y}${m}${d}-${rand}`;
}
function generateInvoiceNumber(sequentialNumber, fiscalYear) {
    const seq = String(sequentialNumber).padStart(5, '0');
    return `HTC/WB/${fiscalYear}/${seq}`;
}
function getCurrentFiscalYear() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    if (month >= 4) {
        return `${String(year).slice(2)}${String(year + 1).slice(2)}`;
    }
    return `${String(year - 1).slice(2)}${String(year).slice(2)}`;
}
function formatIndianCurrency(amount) {
    const parts = amount.toFixed(2).split('.');
    let intPart = parts[0];
    const decPart = parts[1];
    const isNeg = intPart.startsWith('-');
    if (isNeg)
        intPart = intPart.slice(1);
    if (intPart.length <= 3) {
        return `${isNeg ? '-' : ''}₹${intPart}.${decPart}`;
    }
    const last3 = intPart.slice(-3);
    const remaining = intPart.slice(0, -3);
    const formatted = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return `${isNeg ? '-' : ''}₹${formatted},${last3}.${decPart}`;
}
//# sourceMappingURL=gst-calculator.js.map