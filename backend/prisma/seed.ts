import { PrismaClient, RoleName, GstRate, UnitType, CustomerGroup } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ── Roles ──
  const roles = await Promise.all(
    Object.values(RoleName).map((name) =>
      prisma.role.upsert({
        where: { name },
        update: {},
        create: { name, description: `${name.replace(/_/g, ' ')} role` },
      })
    )
  );
  const roleMap = Object.fromEntries(roles.map((r) => [r.name, r.id]));
  console.log(`Created ${roles.length} roles`);

  // ── Permissions ──
  const modules = ['users', 'products', 'pricing', 'geography', 'routes', 'tracking', 'orders', 'inventory', 'schemes', 'payments', 'analytics', 'audit_logs', 'exports'];

  const permMatrix: Record<string, Record<string, { v: boolean; c: boolean; e: boolean; d: boolean; a: boolean }>> = {
    SUPER_ADMIN:      Object.fromEntries(modules.map((m) => [m, { v: true, c: true, e: true, d: true, a: true }])),
    ADMIN:            Object.fromEntries(modules.map((m) => [m, { v: true, c: true, e: true, d: true, a: true }])),
    SALES_MANAGER:    { users: { v: true, c: false, e: false, d: false, a: false }, products: { v: true, c: false, e: false, d: false, a: false }, pricing: { v: true, c: false, e: false, d: false, a: false }, geography: { v: true, c: false, e: false, d: false, a: false }, routes: { v: true, c: true, e: true, d: true, a: true }, tracking: { v: true, c: false, e: false, d: false, a: false }, orders: { v: true, c: true, e: true, d: false, a: true }, inventory: { v: true, c: false, e: false, d: false, a: false }, schemes: { v: true, c: true, e: true, d: true, a: true }, payments: { v: true, c: false, e: false, d: false, a: false }, analytics: { v: true, c: false, e: false, d: false, a: false }, audit_logs: { v: false, c: false, e: false, d: false, a: false }, exports: { v: false, c: false, e: false, d: false, a: false } },
    FIELD_MANAGER:    { users: { v: true, c: false, e: false, d: false, a: false }, products: { v: true, c: false, e: false, d: false, a: false }, pricing: { v: false, c: false, e: false, d: false, a: false }, geography: { v: true, c: false, e: false, d: false, a: false }, routes: { v: true, c: true, e: true, d: false, a: false }, tracking: { v: true, c: false, e: false, d: false, a: false }, orders: { v: true, c: true, e: true, d: false, a: false }, inventory: { v: true, c: false, e: false, d: false, a: false }, schemes: { v: true, c: false, e: false, d: false, a: false }, payments: { v: false, c: false, e: false, d: false, a: false }, analytics: { v: true, c: false, e: false, d: false, a: false }, audit_logs: { v: false, c: false, e: false, d: false, a: false }, exports: { v: false, c: false, e: false, d: false, a: false } },
    SALESMAN:         { users: { v: false, c: false, e: false, d: false, a: false }, products: { v: true, c: false, e: false, d: false, a: false }, pricing: { v: false, c: false, e: false, d: false, a: false }, geography: { v: false, c: false, e: false, d: false, a: false }, routes: { v: true, c: false, e: false, d: false, a: false }, tracking: { v: false, c: true, e: false, d: false, a: false }, orders: { v: true, c: true, e: true, d: false, a: false }, inventory: { v: true, c: false, e: false, d: false, a: false }, schemes: { v: true, c: false, e: false, d: false, a: false }, payments: { v: true, c: true, e: false, d: false, a: false }, analytics: { v: true, c: false, e: false, d: false, a: false }, audit_logs: { v: false, c: false, e: false, d: false, a: false }, exports: { v: false, c: false, e: false, d: false, a: false } },
    DISTRIBUTOR:      { users: { v: true, c: false, e: false, d: false, a: false }, products: { v: true, c: false, e: false, d: false, a: false }, pricing: { v: true, c: false, e: false, d: false, a: false }, geography: { v: false, c: false, e: false, d: false, a: false }, routes: { v: false, c: false, e: false, d: false, a: false }, tracking: { v: false, c: false, e: false, d: false, a: false }, orders: { v: true, c: true, e: true, d: false, a: true }, inventory: { v: true, c: false, e: false, d: false, a: false }, schemes: { v: true, c: false, e: false, d: false, a: false }, payments: { v: true, c: false, e: false, d: false, a: false }, analytics: { v: true, c: false, e: false, d: false, a: false }, audit_logs: { v: false, c: false, e: false, d: false, a: false }, exports: { v: false, c: false, e: false, d: false, a: false } },
    SUB_DISTRIBUTOR:  { users: { v: true, c: false, e: false, d: false, a: false }, products: { v: true, c: false, e: false, d: false, a: false }, pricing: { v: true, c: false, e: false, d: false, a: false }, geography: { v: false, c: false, e: false, d: false, a: false }, routes: { v: false, c: false, e: false, d: false, a: false }, tracking: { v: false, c: false, e: false, d: false, a: false }, orders: { v: true, c: true, e: true, d: false, a: true }, inventory: { v: false, c: false, e: false, d: false, a: false }, schemes: { v: true, c: false, e: false, d: false, a: false }, payments: { v: true, c: false, e: false, d: false, a: false }, analytics: { v: true, c: false, e: false, d: false, a: false }, audit_logs: { v: false, c: false, e: false, d: false, a: false }, exports: { v: false, c: false, e: false, d: false, a: false } },
    RETAILER:         { users: { v: true, c: false, e: false, d: false, a: false }, products: { v: true, c: false, e: false, d: false, a: false }, pricing: { v: false, c: false, e: false, d: false, a: false }, geography: { v: false, c: false, e: false, d: false, a: false }, routes: { v: false, c: false, e: false, d: false, a: false }, tracking: { v: false, c: false, e: false, d: false, a: false }, orders: { v: true, c: true, e: true, d: false, a: false }, inventory: { v: false, c: false, e: false, d: false, a: false }, schemes: { v: true, c: false, e: false, d: false, a: false }, payments: { v: true, c: false, e: false, d: false, a: false }, analytics: { v: true, c: false, e: false, d: false, a: false }, audit_logs: { v: false, c: false, e: false, d: false, a: false }, exports: { v: false, c: false, e: false, d: false, a: false } },
    WAREHOUSE_MANAGER:{ users: { v: false, c: false, e: false, d: false, a: false }, products: { v: true, c: false, e: false, d: false, a: false }, pricing: { v: false, c: false, e: false, d: false, a: false }, geography: { v: false, c: false, e: false, d: false, a: false }, routes: { v: false, c: false, e: false, d: false, a: false }, tracking: { v: false, c: false, e: false, d: false, a: false }, orders: { v: true, c: false, e: false, d: false, a: false }, inventory: { v: true, c: true, e: true, d: true, a: true }, schemes: { v: false, c: false, e: false, d: false, a: false }, payments: { v: false, c: false, e: false, d: false, a: false }, analytics: { v: true, c: false, e: false, d: false, a: false }, audit_logs: { v: false, c: false, e: false, d: false, a: false }, exports: { v: false, c: false, e: false, d: false, a: false } },
    ACCOUNTANT:       { users: { v: false, c: false, e: false, d: false, a: false }, products: { v: true, c: false, e: false, d: false, a: false }, pricing: { v: true, c: false, e: false, d: false, a: false }, geography: { v: false, c: false, e: false, d: false, a: false }, routes: { v: false, c: false, e: false, d: false, a: false }, tracking: { v: false, c: false, e: false, d: false, a: false }, orders: { v: true, c: false, e: false, d: false, a: false }, inventory: { v: true, c: false, e: false, d: false, a: false }, schemes: { v: true, c: false, e: false, d: false, a: false }, payments: { v: true, c: true, e: true, d: true, a: true }, analytics: { v: true, c: false, e: false, d: false, a: false }, audit_logs: { v: true, c: false, e: false, d: false, a: false }, exports: { v: true, c: true, e: true, d: true, a: true } },
  };

  for (const [roleName, perms] of Object.entries(permMatrix)) {
    for (const [mod, p] of Object.entries(perms)) {
      await prisma.permission.upsert({
        where: { roleId_moduleName: { roleId: roleMap[roleName], moduleName: mod } },
        update: { canView: p.v, canCreate: p.c, canEdit: p.e, canDelete: p.d, canApprove: p.a },
        create: { roleId: roleMap[roleName], moduleName: mod, canView: p.v, canCreate: p.c, canEdit: p.e, canDelete: p.d, canApprove: p.a },
      });
    }
  }
  console.log('Created permissions matrix');

  // ── Geography: West Bengal ──
  const wb = await prisma.state.upsert({
    where: { code: 'WB' },
    update: {},
    create: { name: 'West Bengal', code: 'WB' },
  });

  const districts = [
    'Kolkata', 'North 24 Parganas', 'South 24 Parganas', 'Howrah', 'Hooghly',
    'Nadia', 'Murshidabad', 'Bardhaman', 'Birbhum', 'Bankura',
    'Purulia', 'Medinipur West', 'Medinipur East', 'Malda', 'Darjeeling',
    'Siliguri', 'Jalpaiguri', 'Cooch Behar', 'Alipurduar', 'Dakshin Dinajpur',
  ];

  const districtRecords = [];
  for (const name of districts) {
    const d = await prisma.district.upsert({
      where: { name_stateId: { name, stateId: wb.id } },
      update: {},
      create: { name, stateId: wb.id },
    });
    districtRecords.push(d);
  }

  const zoneNames = ['Kolkata Central', 'Kolkata South', 'Kolkata North', 'Salt Lake - Rajarhat', 'Howrah City', 'Hooghly Belt', 'North Bengal', 'Bardhaman Industrial', 'Durgapur-Asansol', 'Diamond Harbour'];
  const zones = [];
  for (let i = 0; i < zoneNames.length; i++) {
    const district = districtRecords[i % districtRecords.length];
    const z = await prisma.zone.upsert({
      where: { id: `zone-seed-${i}` },
      update: {},
      create: { id: `zone-seed-${i}`, name: zoneNames[i], stateId: wb.id, districtId: district.id },
    });
    zones.push(z);
  }
  console.log(`Created ${zones.length} zones`);

  // ── Brands ──
  const brandNames = ['HomeTech Prime', 'BuildStrong', 'AquaShield', 'TileMaster', 'SteelBond'];
  const brands = [];
  for (const name of brandNames) {
    const b = await prisma.brand.upsert({ where: { name }, update: {}, create: { name, description: `${name} construction chemicals` } });
    brands.push(b);
  }

  // ── Categories ──
  const categoryNames = ['Waterproofing', 'Tile Adhesive', 'Wall Putty', 'Epoxy & Grout', 'Concrete Admixture', 'Primer & Coating', 'Repair & Rehabilitation'];
  const categories = [];
  for (const name of categoryNames) {
    const c = await prisma.category.upsert({
      where: { id: `cat-${name.toLowerCase().replace(/\s+/g, '-')}` },
      update: {},
      create: { id: `cat-${name.toLowerCase().replace(/\s+/g, '-')}`, name, description: `${name} products` },
    });
    categories.push(c);
  }

  // ── Password hash ──
  const hash = await bcrypt.hash('Admin@123', 12);

  // ── Users ──
  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@hometech.com' },
    update: {},
    create: { name: 'Rajesh Kumar Singh', email: 'admin@hometech.com', phone: '9876543210', passwordHash: hash, roleId: roleMap.SUPER_ADMIN, zoneId: zones[0].id, isVerified: true },
  });

  const admin = await prisma.user.upsert({
    where: { email: 'ops@hometech.in' },
    update: {},
    create: { name: 'Amit Chatterjee', email: 'ops@hometech.in', phone: '9876543211', passwordHash: hash, roleId: roleMap.ADMIN, zoneId: zones[0].id, isVerified: true, createdBy: superAdmin.id },
  });

  const salesManager = await prisma.user.upsert({
    where: { email: 'sm@hometech.in' },
    update: {},
    create: { name: 'Suresh Banerjee', email: 'sm@hometech.in', phone: '9876543212', passwordHash: hash, roleId: roleMap.SALES_MANAGER, zoneId: zones[0].id, isVerified: true, createdBy: admin.id },
  });

  const fieldManager = await prisma.user.upsert({
    where: { email: 'fm@hometech.in' },
    update: {},
    create: { name: 'Debashish Ghosh', email: 'fm@hometech.in', phone: '9876543213', passwordHash: hash, roleId: roleMap.FIELD_MANAGER, zoneId: zones[1].id, isVerified: true, createdBy: salesManager.id },
  });

  const salesmanNames = [
    { name: 'Ravi Das', email: 'ravi@hometech.in', phone: '9876543214', zone: 0 },
    { name: 'Sourav Mondal', email: 'sourav@hometech.in', phone: '9876543215', zone: 1 },
    { name: 'Arjun Saha', email: 'arjun@hometech.in', phone: '9876543216', zone: 2 },
    { name: 'Prakash Roy', email: 'prakash@hometech.in', phone: '9876543217', zone: 3 },
    { name: 'Bikash Dutta', email: 'bikash@hometech.in', phone: '9876543218', zone: 4 },
  ];

  const salesmen = [];
  for (const s of salesmanNames) {
    const user = await prisma.user.upsert({
      where: { email: s.email },
      update: {},
      create: { name: s.name, email: s.email, phone: s.phone, passwordHash: hash, roleId: roleMap.SALESMAN, zoneId: zones[s.zone].id, parentUserId: fieldManager.id, isVerified: true, createdBy: fieldManager.id },
    });
    salesmen.push(user);
  }

  const distributor = await prisma.user.upsert({
    where: { email: 'dist1@hometech.in' },
    update: {},
    create: { name: 'Kolkata Building Supplies Pvt Ltd', email: 'dist1@hometech.in', phone: '9876543220', passwordHash: hash, roleId: roleMap.DISTRIBUTOR, zoneId: zones[0].id, isVerified: true, createdBy: admin.id },
  });

  const subDist = await prisma.user.upsert({
    where: { email: 'subdist1@hometech.in' },
    update: {},
    create: { name: 'Howrah Hardware Point', email: 'subdist1@hometech.in', phone: '9876543221', passwordHash: hash, roleId: roleMap.SUB_DISTRIBUTOR, zoneId: zones[4].id, parentUserId: distributor.id, isVerified: true, createdBy: distributor.id },
  });

  const retailerNames = [
    { name: 'Sharma Hardware Store', email: 'sharma@shop.in', phone: '9876543230', zone: 0 },
    { name: 'Gupta Building Materials', email: 'gupta@shop.in', phone: '9876543231', zone: 1 },
    { name: 'Roy Construction Centre', email: 'roy@shop.in', phone: '9876543232', zone: 2 },
    { name: 'Mukherjee Cement House', email: 'mukherjee@shop.in', phone: '9876543233', zone: 3 },
    { name: 'Patel Hardware Mart', email: 'patel@shop.in', phone: '9876543234', zone: 4 },
    { name: 'Singh Building Supply', email: 'singhbs@shop.in', phone: '9876543235', zone: 0 },
    { name: 'Das Enterprise', email: 'das@shop.in', phone: '9876543236', zone: 1 },
    { name: 'Mondal Traders', email: 'mondal@shop.in', phone: '9876543237', zone: 2 },
  ];

  const retailers = [];
  for (const r of retailerNames) {
    const user = await prisma.user.upsert({
      where: { email: r.email },
      update: {},
      create: { name: r.name, email: r.email, phone: r.phone, passwordHash: hash, roleId: roleMap.RETAILER, zoneId: zones[r.zone].id, parentUserId: subDist.id, isVerified: true, createdBy: subDist.id },
    });
    retailers.push(user);
  }

  const whManager = await prisma.user.upsert({
    where: { email: 'wh@hometech.in' },
    update: {},
    create: { name: 'Tapan Karmakar', email: 'wh@hometech.in', phone: '9876543240', passwordHash: hash, roleId: roleMap.WAREHOUSE_MANAGER, zoneId: zones[0].id, isVerified: true, createdBy: admin.id },
  });

  const accountant = await prisma.user.upsert({
    where: { email: 'accounts@hometech.in' },
    update: {},
    create: { name: 'Anirban Mukherjee', email: 'accounts@hometech.in', phone: '9876543241', passwordHash: hash, roleId: roleMap.ACCOUNTANT, zoneId: zones[0].id, isVerified: true, createdBy: admin.id },
  });

  console.log('Created users with hierarchy');

  // ── Products ──
  const productData = [
    { sku: 'HTC-WP-001', name: 'AquaShield 2K Waterproofing Compound', brandIdx: 2, catIdx: 0, unit: UnitType.KG, price: 450, hsn: '3214', gst: GstRate.GST_18, weight: 20 },
    { sku: 'HTC-WP-002', name: 'AquaShield Liquid Membrane', brandIdx: 2, catIdx: 0, unit: UnitType.LITRE, price: 680, hsn: '3214', gst: GstRate.GST_18, weight: 10 },
    { sku: 'HTC-TA-001', name: 'TileMaster Premium White Adhesive', brandIdx: 3, catIdx: 1, unit: UnitType.BAG, price: 520, hsn: '3506', gst: GstRate.GST_18, weight: 25 },
    { sku: 'HTC-TA-002', name: 'TileMaster Grey Floor Adhesive', brandIdx: 3, catIdx: 1, unit: UnitType.BAG, price: 380, hsn: '3506', gst: GstRate.GST_18, weight: 25 },
    { sku: 'HTC-WP-003', name: 'BuildStrong Wall Putty', brandIdx: 1, catIdx: 2, unit: UnitType.BAG, price: 290, hsn: '3214', gst: GstRate.GST_18, weight: 40 },
    { sku: 'HTC-EP-001', name: 'HomeTech Epoxy Grout 2-Part', brandIdx: 0, catIdx: 3, unit: UnitType.KG, price: 1250, hsn: '3907', gst: GstRate.GST_18, weight: 5 },
    { sku: 'HTC-CA-001', name: 'BuildStrong Plasticizer Admixture', brandIdx: 1, catIdx: 4, unit: UnitType.LITRE, price: 180, hsn: '3824', gst: GstRate.GST_18, weight: 20 },
    { sku: 'HTC-CA-002', name: 'BuildStrong Super Retarder', brandIdx: 1, catIdx: 4, unit: UnitType.LITRE, price: 220, hsn: '3824', gst: GstRate.GST_18, weight: 20 },
    { sku: 'HTC-PR-001', name: 'HomeTech Prime Coat Primer', brandIdx: 0, catIdx: 5, unit: UnitType.LITRE, price: 350, hsn: '3208', gst: GstRate.GST_28, weight: 10 },
    { sku: 'HTC-PR-002', name: 'AquaShield Anti-Carbonation Coating', brandIdx: 2, catIdx: 5, unit: UnitType.LITRE, price: 890, hsn: '3208', gst: GstRate.GST_28, weight: 10 },
    { sku: 'HTC-RR-001', name: 'SteelBond Repair Mortar', brandIdx: 4, catIdx: 6, unit: UnitType.KG, price: 560, hsn: '3824', gst: GstRate.GST_18, weight: 25 },
    { sku: 'HTC-RR-002', name: 'SteelBond Micro Concrete', brandIdx: 4, catIdx: 6, unit: UnitType.KG, price: 480, hsn: '3824', gst: GstRate.GST_18, weight: 25 },
    { sku: 'HTC-WP-004', name: 'AquaShield Terrace Waterproofing Kit', brandIdx: 2, catIdx: 0, unit: UnitType.SET, price: 2800, hsn: '3214', gst: GstRate.GST_18, weight: 30 },
    { sku: 'HTC-TA-003', name: 'TileMaster Stone Cladding Adhesive', brandIdx: 3, catIdx: 1, unit: UnitType.BAG, price: 750, hsn: '3506', gst: GstRate.GST_18, weight: 25 },
    { sku: 'HTC-WP-005', name: 'BuildStrong Cement Primer', brandIdx: 1, catIdx: 2, unit: UnitType.LITRE, price: 420, hsn: '3214', gst: GstRate.GST_18, weight: 10 },
  ];

  const products = [];
  for (const p of productData) {
    const product = await prisma.product.upsert({
      where: { sku: p.sku },
      update: {},
      create: { sku: p.sku, name: p.name, brandId: brands[p.brandIdx].id, categoryId: categories[p.catIdx].id, unitType: p.unit, basePrice: p.price, hsnCode: p.hsn, gstRate: p.gst, weightKg: p.weight, createdBy: admin.id },
    });
    products.push(product);
  }
  console.log(`Created ${products.length} products`);

  // ── Warehouses ──
  const warehouseData = [
    { name: 'Kolkata Central Warehouse', address: 'Plot 15, Salt Lake Sector V, Kolkata 700091', zone: 0 },
    { name: 'Howrah Distribution Centre', address: '42, GT Road, Howrah 711101', zone: 4 },
    { name: 'Siliguri Regional Warehouse', address: 'Hill Cart Road, Siliguri 734001', zone: 6 },
  ];

  const warehouses = [];
  for (const w of warehouseData) {
    const wh = await prisma.warehouse.create({
      data: { name: w.name, address: w.address, zoneId: zones[w.zone].id, managerId: whManager.id, createdBy: admin.id },
    });
    warehouses.push(wh);
  }

  // ── Inventory ──
  for (const wh of warehouses) {
    for (const product of products) {
      await prisma.inventory.upsert({
        where: { productId_warehouseId: { productId: product.id, warehouseId: wh.id } },
        update: {},
        create: { productId: product.id, warehouseId: wh.id, quantityOnHand: Math.floor(Math.random() * 500) + 50, reorderThreshold: 20, lastStockDate: new Date(), createdBy: whManager.id },
      });
    }
  }
  console.log('Created inventory records');

  // ── Pricing Rules ──
  const groups: CustomerGroup[] = ['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'DIRECT'];
  const margins = { DISTRIBUTOR: 15, SUB_DISTRIBUTOR: 20, RETAILER: 30, DIRECT: 35 };

  for (const product of products) {
    for (const group of groups) {
      await prisma.pricingRule.create({
        data: { productId: product.id, customerGroup: group, priceType: 'MARGIN_PERCENT', priceValue: margins[group], validFrom: new Date('2024-04-01'), isActive: true, createdBy: admin.id },
      });
    }
  }
  console.log('Created pricing rules');

  // ── Schemes ──
  await prisma.scheme.create({
    data: { name: 'Q4 Volume Booster', description: 'Achieve quarterly targets for bonus rewards', schemeType: 'TARGET_REWARD', applicableRole: 'SALESMAN', validFrom: new Date('2025-01-01'), validTo: new Date('2025-03-31'), rewardType: 'CASH', rewardValue: 5000, conditions: { targetSales: 500000 }, createdBy: salesManager.id },
  });

  await prisma.scheme.create({
    data: { name: 'Waterproofing Bundle Offer', description: 'Buy 50 bags, get 5 free on waterproofing products', schemeType: 'VOLUME_SLAB', applicableRole: 'RETAILER', validFrom: new Date('2025-01-01'), validTo: new Date('2025-06-30'), rewardType: 'PRODUCT', rewardValue: 5, conditions: { minQuantity: 50, categoryId: categories[0].id }, createdBy: salesManager.id },
  });

  await prisma.scheme.create({
    data: { name: 'Distributor Growth Reward', description: 'MTD target-based cash incentive for distributors', schemeType: 'TARGET_REWARD', applicableRole: 'DISTRIBUTOR', validFrom: new Date('2025-01-01'), validTo: new Date('2025-12-31'), rewardType: 'CREDIT_NOTE', rewardValue: 25000, conditions: { targetSales: 2000000 }, createdBy: admin.id },
  });
  console.log('Created schemes');

  console.log('\n=== Seed Complete ===');
  console.log('Login credentials: any user email with password "Password@123"');
  console.log('Super Admin: admin@hometech.in');
  console.log('Admin: ops@hometech.in');
  console.log('Sales Manager: sm@hometech.in');
  console.log('Salesman: ravi@hometech.in');
  console.log('Distributor: dist1@hometech.in');
  console.log('Retailer: sharma@shop.in');
  console.log('Warehouse Mgr: wh@hometech.in');
  console.log('Accountant: accounts@hometech.in');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
