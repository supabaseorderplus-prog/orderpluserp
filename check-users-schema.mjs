import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://nsdmqbnfnauznyksxckh.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZG1xYm5mbmF1em55a3N4Y2toIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDE2NjcxOSwiZXhwIjoyMDg5NzQyNzE5fQ.t05iPC_0kFJFqs7eFC4P2pOI5ojyk2pKVCTT7K4_vN0';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkUsersSchema() {
  try {
    console.log('Checking users table schema...');
    
    // Try to get column information
    const { data, error } = await supabase.rpc('exec_sql', {
      query: `SELECT column_name, data_type, is_nullable 
              FROM information_schema.columns 
              WHERE table_name = 'users' AND table_schema = 'public'
              ORDER BY ordinal_position`
    });
    
    if (error) {
      console.log('Error getting schema:', error.message);
      
      // Alternative approach - try to query the table directly
      const { data: sampleData, error: sampleError } = await supabase
        .from('users')
        .select('*')
        .limit(1);
      
      if (sampleError) {
        console.log('Sample query error:', sampleError.message);
      } else {
        console.log('Sample data keys:', Object.keys(sampleData[0] || {}));
      }
    } else {
      console.log('Users table columns:');
      data.forEach(col => {
        console.log(`  ${col.column_name} (${col.data_type}) ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
      });
      
      // Check if party_id exists
      const hasPartyId = data.some(col => col.column_name === 'party_id');
      console.log(`\nHas party_id column: ${hasPartyId ? 'YES' : 'NO'}`);
    }
  } catch (err) {
    console.error('Unexpected error:', err.message);
  }
}

checkUsersSchema();