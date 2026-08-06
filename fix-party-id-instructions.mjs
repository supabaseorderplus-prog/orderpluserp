console.log(`
🔧 FIX: Add party_id column to users table

Please run the following SQL in your Supabase SQL Editor:

🌐 Go to: https://supabase.com/dashboard/project/nsdmqbnfnauznyksxckh/sql

📋 Copy and paste this SQL:

ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS party_id UUID 
REFERENCES public.parties(id) 
ON DELETE SET NULL;

🔄 After running the SQL, refresh the page and try creating a user again.

The error occurs because the frontend code expects a 'party_id' column in the users table, but it doesn't exist in your database schema.
`);