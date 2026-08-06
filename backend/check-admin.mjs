import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkAdmin() {
  try {
    console.log('Checking super admin user...');

    const user = await prisma.user.findUnique({
      where: { email: 'admin@hometech.com' },
      include: { role: true }
    });

    if (user) {
      console.log('User found:');
      console.log(`Email: ${user.email}`);
      console.log(`Name: ${user.name}`);
      console.log(`Role: ${user.role.name}`);
      console.log(`Status: ${user.status}`);
      console.log(`Is Verified: ${user.isVerified}`);
      console.log(`Password Hash exists: ${!!user.passwordHash}`);
      console.log(`Password Hash length: ${user.passwordHash?.length || 0}`);
    } else {
      console.log('User not found!');
    }

  } catch (error) {
    console.error('Error checking admin user:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkAdmin();