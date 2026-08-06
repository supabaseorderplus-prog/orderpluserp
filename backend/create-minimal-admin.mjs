import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function createMinimalAdmin() {
  try {
    console.log('Creating super admin user with minimal setup...');

    // Generate the hash for Admin@123
    const hash = await bcrypt.hash('Admin@123', 12);
    console.log('Password hash generated');

    // First, ensure SUPER_ADMIN role exists
    let superAdminRole = await prisma.role.findUnique({
      where: { name: 'SUPER_ADMIN' }
    });

    if (!superAdminRole) {
      console.log('Creating SUPER_ADMIN role...');
      superAdminRole = await prisma.role.create({
        data: {
          name: 'SUPER_ADMIN',
          description: 'Super Administrator with full system access',
          status: 'ACTIVE'
        }
      });
      console.log('SUPER_ADMIN role created');
    }

    // Check if we need a zone (it's optional based on schema)
    let zoneId = null;
    const existingZone = await prisma.zone.findFirst();
    if (existingZone) {
      zoneId = existingZone.id;
    }

    // Create or update the super admin user
    const user = await prisma.user.upsert({
      where: { email: 'admin@hometech.com' },
      update: {
        passwordHash: hash,
        status: 'ACTIVE',
        isVerified: true,
        roleId: superAdminRole.id
      },
      create: {
        name: 'Super Admin',
        email: 'admin@hometech.com',
        phone: '9999999999',
        passwordHash: hash,
        roleId: superAdminRole.id,
        zoneId: zoneId,
        isVerified: true,
        status: 'ACTIVE'
      }
    });

    console.log('\n✅ Super admin user created/updated successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📧 Email: ${user.email}`);
    console.log(`🔑 Password: Admin@123`);
    console.log(`👤 Name: ${user.name}`);
    console.log(`🎭 Role: SUPER_ADMIN`);
    console.log(`✓ Status: ${user.status}`);
    console.log(`✓ Verified: ${user.isVerified}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('❌ Error creating admin user:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

createMinimalAdmin();
