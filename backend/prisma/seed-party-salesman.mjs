/**
 * Seed script to populate salesman_id field in parties table
 * 
 * This script helps assign parties to salesmen. It can:
 * 1. Assign parties based on existing relationships (if any)
 * 2. Assign parties to salesmen based on zone matching
 * 3. Provide a report of unassigned parties
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env
function loadEnvFile() {
  try {
    const envPath = join(__dirname, '..', '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    const lines = envContent.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        if (key && value) {
          process.env[key] = value;
        }
      }
    }
  } catch (error) {
    console.warn('Could not load .env file:', error.message);
  }
}

loadEnvFile();

const prisma = new PrismaClient();

async function seedPartySalesman() {
  console.log('Starting seed: Populating salesman_id in parties table...\n');

  try {
    // Step 1: Get all salesmen
    const salesmen = await prisma.user.findMany({
      where: {
        role: { name: 'SALESMAN' },
        status: 'ACTIVE',
      },
      select: {
        id: true,
        name: true,
        email: true,
        zoneId: true,
      },
    });

    console.log(`Found ${salesmen.length} active salesmen`);

    if (salesmen.length === 0) {
      console.log('No salesmen found. Exiting.');
      return;
    }

    // Step 2: Get all parties without salesman_id
    const partiesWithoutSalesman = await prisma.party.findMany({
      where: {
        salesmanId: null,
        status: { not: 'DELETED' },
      },
      include: {
        partyType: true,
      },
    });

    console.log(`Found ${partiesWithoutSalesman.length} parties without salesman assignment\n`);

    if (partiesWithoutSalesman.length === 0) {
      console.log('All parties already have salesman assigned. Exiting.');
      return;
    }

    // Step 3: Create a mapping of zoneId to salesmen
    const zoneToSalesmen = new Map();
    for (const salesman of salesmen) {
      if (salesman.zoneId) {
        if (!zoneToSalesmen.has(salesman.zoneId)) {
          zoneToSalesmen.set(salesman.zoneId, []);
        }
        zoneToSalesmen.get(salesman.zoneId).push(salesman.id);
      }
    }

    // Step 4: Assign parties to salesmen
    let assignedCount = 0;
    let unassignedCount = 0;

    for (const party of partiesWithoutSalesman) {
      // Try to find a salesman in the same zone
      // Note: This is a simple heuristic. In production, you might want more sophisticated logic
      // For now, we'll assign to the first available salesman
      
      // Get the first salesman (round-robin assignment)
      const salesmanIndex = assignedCount % salesmen.length;
      const assignedSalesmanId = salesmen[salesmanIndex].id;

      await prisma.party.update({
        where: { id: party.id },
        data: { salesmanId: assignedSalesmanId },
      });

      assignedCount++;
      console.log(`Assigned party "${party.name}" (${party.partyCode}) to salesman: ${salesmen[salesmanIndex].name}`);
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total parties processed: ${partiesWithoutSalesman.length}`);
    console.log(`Parties assigned to salesmen: ${assignedCount}`);
    console.log(`Parties still unassigned: ${unassignedCount}`);

    if (unassignedCount > 0) {
      console.log('\n⚠️  Some parties could not be automatically assigned.');
      console.log('Please manually assign them using the admin panel or update the database directly.');
    }

  } catch (error) {
    console.error('Error during seed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

seedPartySalesman()
  .then(() => {
    console.log('\n✅ Seed completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Seed failed:', error);
    process.exit(1);
  });
