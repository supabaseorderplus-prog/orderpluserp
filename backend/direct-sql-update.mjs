import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function updateAdminDirectly() {
  try {
    console.log('Generating password hash...');

    // Generate the hash using bcryptjs (same as what we'll use for verification)
    const hash = await bcrypt.hash('Admin@123', 12);
    console.log('Hash generated successfully');

    // Update the user directly in the database
    const result = await prisma.$executeRaw`
      UPDATE users
      SET password_hash = ${hash}
      WHERE email = 'admin@hometech.com'
    `;

    console.log(`Updated ${result} user(s)`);

    // Verify the user exists
    const user = await prisma.user.findUnique({
      where: { email: 'admin@hometech.com' },
      select: {
        id: true,
        email: true,
        name: true,
        role: { select: { name: true } },
        status: true,
        isVerified: true
      }
    });

    if (user) {
      console.log('User verification:');
      console.log(`Email: ${user.email}`);
      console.log(`Name: ${user.name}`);
      console.log(`Role: ${user.role.name}`);
      console.log(`Status: ${user.status}`);
      console.log(`Is Verified: ${user.isVerified}`);
    } else {
      console.log('User not found after update!');
    }

  } catch (error) {
    console.error('Error updating admin:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateAdminDirectly();