"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const gst_calculator_1 = require("../../utils/gst-calculator");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/tally', (0, rbac_1.checkPermission)('exports', 'view'), async (req, res, next) => {
    try {
        const { from, to } = req.query;
        const where = { status: { in: ['DELIVERED', 'DISPATCHED'] } };
        if (from || to) {
            where.createdAt = {};
            if (from)
                where.createdAt.gte = new Date(from);
            if (to)
                where.createdAt.lte = new Date(to);
        }
        const orders = await db_1.prisma.order.findMany({
            where: where,
            include: { buyer: true, items: { include: { product: true } } },
            orderBy: { createdAt: 'asc' },
        });
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>\n<HEADER>\n<TALLYREQUEST>Import Data</TALLYREQUEST>\n</HEADER>\n<BODY>\n<IMPORTDATA>\n<REQUESTDESC>\n<REPORTNAME>Vouchers</REPORTNAME>\n</REQUESTDESC>\n<REQUESTDATA>\n';
        for (const order of orders) {
            xml += `<TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
            xml += `<VOUCHER VCHTYPE="Sales" ACTION="Create">\n`;
            xml += `<DATE>${formatTallyDate(order.createdAt)}</DATE>\n`;
            xml += `<VOUCHERNUMBER>${order.orderNumber}</VOUCHERNUMBER>\n`;
            xml += `<PARTYLEDGERNAME>${escapeXml(order.buyer.name)}</PARTYLEDGERNAME>\n`;
            xml += `<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>\n`;
            for (const item of order.items) {
                const gst = (0, gst_calculator_1.calculateGst)(Number(item.lineTotal), item.gstRate);
                xml += `<ALLINVENTORYENTRIES.LIST>\n`;
                xml += `<STOCKITEMNAME>${escapeXml(item.product.name)}</STOCKITEMNAME>\n`;
                xml += `<RATE>${Number(item.unitPrice)}</RATE>\n`;
                xml += `<AMOUNT>-${Number(item.lineTotal)}</AMOUNT>\n`;
                xml += `<ACTUALQTY>${item.quantity}</ACTUALQTY>\n`;
                xml += `</ALLINVENTORYENTRIES.LIST>\n`;
                xml += `<LEDGERENTRIES.LIST>\n`;
                xml += `<LEDGERNAME>CGST</LEDGERNAME>\n`;
                xml += `<AMOUNT>-${gst.cgstAmount}</AMOUNT>\n`;
                xml += `</LEDGERENTRIES.LIST>\n`;
                xml += `<LEDGERENTRIES.LIST>\n`;
                xml += `<LEDGERNAME>SGST</LEDGERNAME>\n`;
                xml += `<AMOUNT>-${gst.sgstAmount}</AMOUNT>\n`;
                xml += `</LEDGERENTRIES.LIST>\n`;
            }
            xml += `<LEDGERENTRIES.LIST>\n`;
            xml += `<LEDGERNAME>${escapeXml(order.buyer.name)}</LEDGERNAME>\n`;
            xml += `<AMOUNT>${Number(order.grandTotal)}</AMOUNT>\n`;
            xml += `</LEDGERENTRIES.LIST>\n`;
            xml += `</VOUCHER>\n</TALLYMESSAGE>\n`;
        }
        xml += '</REQUESTDATA>\n</IMPORTDATA>\n</BODY>\n</ENVELOPE>';
        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('Content-Disposition', `attachment; filename="tally-export-${new Date().toISOString().split('T')[0]}.xml"`);
        res.send(xml);
    }
    catch (error) {
        next(error);
    }
});
router.get('/busy', (0, rbac_1.checkPermission)('exports', 'view'), async (req, res, next) => {
    try {
        const { from, to } = req.query;
        const where = { status: { in: ['DELIVERED', 'DISPATCHED'] } };
        if (from || to) {
            where.createdAt = {};
            if (from)
                where.createdAt.gte = new Date(from);
            if (to)
                where.createdAt.lte = new Date(to);
        }
        const orders = await db_1.prisma.order.findMany({
            where: where,
            include: { buyer: true, items: { include: { product: true } } },
            orderBy: { createdAt: 'asc' },
        });
        let csv = 'Voucher Type,Date,Voucher No,Party Name,Amount,GST Amount,Total,Narration\n';
        for (const order of orders) {
            const date = order.createdAt.toISOString().split('T')[0];
            csv += `Sales,${date},${order.orderNumber},"${order.buyer.name}",${Number(order.subtotal)},${Number(order.gstAmount)},${Number(order.grandTotal)},"Sales voucher"\n`;
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="busy-export-${new Date().toISOString().split('T')[0]}.csv"`);
        res.send(csv);
    }
    catch (error) {
        next(error);
    }
});
router.get('/orders', (0, rbac_1.checkPermission)('exports', 'view'), async (req, res, next) => {
    try {
        const { from, to } = req.query;
        const where = {};
        if (from || to) {
            where.createdAt = {};
            if (from)
                where.createdAt.gte = new Date(from);
            if (to)
                where.createdAt.lte = new Date(to);
        }
        const orders = await db_1.prisma.order.findMany({
            where: where,
            include: { buyer: true, seller: true, salesman: true, zone: true, items: { include: { product: true } } },
            orderBy: { createdAt: 'asc' },
        });
        let csv = 'Order Number,Date,Buyer,Seller,Salesman,Zone,Subtotal,Discount,GST,Grand Total,Status,Payment Status\n';
        for (const order of orders) {
            const date = order.createdAt.toISOString().split('T')[0];
            csv += `${order.orderNumber},${date},"${order.buyer.name}","${order.seller.name}","${order.salesman?.name || ''}","${order.zone.name}",${Number(order.subtotal)},${Number(order.discountAmount)},${Number(order.gstAmount)},${Number(order.grandTotal)},${order.status},${order.paymentStatus}\n`;
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="orders-export-${new Date().toISOString().split('T')[0]}.csv"`);
        res.send(csv);
    }
    catch (error) {
        next(error);
    }
});
function formatTallyDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}
function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
exports.default = router;
//# sourceMappingURL=routes.js.map