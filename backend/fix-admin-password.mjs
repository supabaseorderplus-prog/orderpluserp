import { PrismaClient } from '@prisma/client';
import bcryptjs from 'bcryptjs';

const prisma = new PrismaClient();

async function fixAdminPassword() {
  try {
    console.log('Fixing super admin password with bcryptjs...');

    // Hash the password using bcryptjs (same as auth service)
    const hash = await bcryptjs.hash('Admin@123', 12);
    console.log('Password hash generated with bcryptjs');

    // Update the super admin user
    const updatedUser = await prisma.user.update({
      where: { email: 'admin@hometech.com' },
      data: {
        passwordHash: hash,
        status: 'ACTIVE',
        isVerified: true
      }
    });

    console.log('\n✅ Super admin password fixed successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📧 Email: ${updatedUser.email}`);
    console.log(`🔑 Password: Admin@123`);
    console.log(`👤 Name: ${updatedUser.name}`);
    console.log(`✓ Status: ${updatedUser.status}`);
    console.log(`✓ Verified: ${updatedUser.isVerified}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('❌ Error fixing admin password:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

fixAdminPassword();
