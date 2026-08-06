# Supabase Setup

This project is configured to use Supabase for both browser and server-side access.

## 1) Environment variables

Add these values to `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=your-project-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_DB_URL=postgresql://...
```

Notes:
- `NEXT_PUBLIC_*` values are safe for client-side usage.
- `SUPABASE_SERVICE_ROLE_KEY` must stay server-only and never be exposed in client components.

## 2) Available clients

- Browser/client components: `src/lib/supabase.ts`
  - Exports typed `supabase` client using anon key.

- Server/API routes: `src/lib/supabase-server.ts`
  - Exports `supabaseAdmin` for privileged server operations.

## 3) Quick usage

Client-side query example:

```ts
import { supabase } from '@/lib/supabase'

const { data, error } = await supabase.from('users').select('*').limit(10)
```

Server-side query example:

```ts
import { supabaseAdmin } from '@/lib/supabase-server'

const { data, error } = await supabaseAdmin.from('users').select('*').limit(10)
```
