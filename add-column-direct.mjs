import { Client } from 'pg';

async function addPartyIdColumnDirect() {
  const client = new Client({
    host: 'db.nsdmqbnfnauznyksxckh.supabase.co',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: 'Shanaya@jan2025',
  });

  try {
    await client.connect();
    console.log('Connected to database');
    
    const query = `
      ALTER TABLE public.users 
      ADD COLUMN IF NOT EXISTS party_id UUID 
      REFERENCES public.parties(id) 
      ON DELETE SET NULL;
    `;
    
    console.log('Executing query:', query);
    const result = await client.query(query);
    console.log('✅ Successfully added party_id column to users table!');
    console.log('Result:', result);
    
    // Verify the column exists
    const verifyQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND table_schema = 'public' 
      AND column_name = 'party_id';
    `;
    
    const verifyResult = await client.query(verifyQuery);
    if (verifyResult.rows.length > 0) {
      console.log('✅ Verification successful - party_id column exists');
    } else {
      console.log('❌ Verification failed - party_id column not found');
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

addPartyIdColumnDirect();