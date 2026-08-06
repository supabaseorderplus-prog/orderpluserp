import { GstRate } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
export declare function getGstPercent(rate: GstRate): number;
export interface GstBreakdown {
    taxableAmount: number;
    cgstRate: number;
    cgstAmount: number;
    sgstRate: number;
    sgstAmount: number;
    igstRate: number;
    igstAmount: number;
    totalTax: number;
    totalWithTax: number;
    isInterstate: boolean;
}
export declare function calculateGst(amount: number | Decimal, gstRate: GstRate, isInterstate?: boolean): GstBreakdown;
export declare function generateOrderNumber(date?: Date): string;
export declare function generateInvoiceNumber(sequentialNumber: number, fiscalYear: string): string;
export declare function getCurrentFiscalYear(): string;
export declare function formatIndianCurrency(amount: number): string;
//# sourceMappingURL=gst-calculator.d.ts.map