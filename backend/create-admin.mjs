import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function createAdminUser() {
  try {
    console.log('Creating super admin user...');

    // Generate the hash
    const hash = await bcrypt.hash('Admin@123', 12);
    console.log('Password hash generated');

    // Check if roles exist first
    const superAdminRole = await prisma.role.findUnique({
      where: { name: 'SUPER_ADMIN' }
    });

    if (!superAdminRole) {
      throw new Error('SUPER_ADMIN role not found. Please run the full seed first.');
    }

    // Check if zones exist
    const zone = await prisma.zone.findFirst();
    if (!zone) {
      throw new Error('No zones found. Please run the full seed first.');
    }

    // Create the super admin user
    const user = await prisma.user.upsert({
      where: { email: 'admin@hometech.com' },
      update: {
        passwordHash: hash,
        status: 'ACTIVE',
        isVerified: true
      },
      create: {
        name: 'Rajesh Kumar Singh',
        email: 'admin@hometech.com',
        phone: '9876543210',
        passwordHash: hash,
        roleId: superAdminRole.id,
        zoneId: zone.id,
        isVerified: true,
        status: 'ACTIVE'
      }
    });

    console.log('Super admin user created successfully!');
    console.log(`Email: ${user.email}`);
    console.log(`Name: ${user.name}`);
    console.log(`Role: SUPER_ADMIN`);
    console.log(`Status: ${user.status}`);
    console.log(`Verified: ${user.isVerified}`);

  } catch (error) {
    console.error('Error creating admin user:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createAdminUser();