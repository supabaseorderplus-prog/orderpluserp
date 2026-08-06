import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://nsdmqbnfnauznyksxckh.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZG1xYm5mbmF1em55a3N4Y2toIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDE2NjcxOSwiZXhwIjoyMDg5NzQyNzE5fQ.t05iPC_0kFJFqs7eFC4P2pOI5ojyk2pKVCTT7K4_vN0';

const supabase = createClient(supabaseUrl, supabaseKey);

async function addPartyIdColumn() {
  try {
    console.log('Adding party_id column to users table...');
    
    // Add the party_id column
    const { error } = await supabase.rpc('exec_sql', {
      query: `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS party_id UUID REFERENCES public.parties(id) ON DELETE SET NULL;`
    });
    
    if (error) {
      console.log('Error adding column:', error.message);
      
      // Try alternative approach using direct SQL execution
      try {
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({
            query: `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS party_id UUID REFERENCES public.parties(id) ON DELETE SET NULL;`
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.log('Direct SQL execution failed:', errorText);
          
          // Last resort - try to create the function first
          console.log('Creating exec_sql function...');
          const createFunctionQuery = `
            CREATE OR REPLACE FUNCTION exec_sql(query text)
            RETURNS void AS $$
            BEGIN
              EXECUTE query;
            END;
            $$ LANGUAGE plpgsql SECURITY DEFINER;
          `;
          
          const response2 = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({ query: createFunctionQuery })
          });
          
          if (response2.ok) {
            console.log('Function created, retrying column addition...');
            const response3 = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
              },
              body: JSON.stringify({
                query: `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS party_id UUID REFERENCES public.parties(id) ON DELETE SET NULL;`
              })
            });
            
            if (response3.ok) {
              console.log('✅ Successfully added party_id column to users table!');
            } else {
              const errorText3 = await response3.text();
              console.log('Failed after function creation:', errorText3);
            }
          } else {
            const errorText2 = await response2.text();
            console.log('Failed to create function:', errorText2);
          }
        } else {
          console.log('✅ Successfully added party_id column to users table!');
        }
      } catch (directError) {
        console.log('Direct execution error:', directError.message);
      }
    } else {
      console.log('✅ Successfully added party_id column to users table!');
    }
    
    // Verify the column was added
    console.log('\nVerifying column addition...');
    const { data: columns, error: verifyError } = await supabase.rpc('exec_sql', {
      query: `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND table_schema = 'public' AND column_name = 'party_id';`
    });
    
    if (verifyError) {
      console.log('Verification error:', verifyError.message);
    } else {
      if (columns && columns.length > 0) {
        console.log('✅ Column verification successful - party_id column exists');
      } else {
        console.log('❌ Column verification failed - party_id column not found');
      }
    }
    
  } catch (err) {
    console.error('Unexpected error:', err.message);
  }
}

addPartyIdColumn();