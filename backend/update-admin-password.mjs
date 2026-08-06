import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function updateAdminPassword() {
  try {
    console.log('Updating super admin password...');

    // Hash the new password
    const hash = await bcrypt.hash('Admin@123', 12);

    // Update the existing super admin user
    const updatedUser = await prisma.user.update({
      where: { email: 'admin@hometech.com' },
      data: {
        passwordHash: hash
      }
    });

    console.log('Super admin password updated successfully!');
    console.log(`Email: ${updatedUser.email}`);
    console.log('Password: Admin@123');

  } catch (error) {
    console.error('Error updating admin password:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateAdminPassword();