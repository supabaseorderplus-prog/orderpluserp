# Supabase Power - Getting Started

## Setup Complete! ✅

You've successfully set up the Supabase power. Here's what we did:

1. ✅ Installed Supabase CLI (via npx)
2. ✅ Logged into Supabase
3. ✅ Initialized Supabase in your project
4. ✅ Linked to your hosted project: `nsdmqbnfnauznyksxckh`
5. ✅ Generated TypeScript types

## Your Database Overview

Your database has **40 tables** including:
- `users` (1 row)
- `roles` (10 rows)
- `permissions` (134 rows)
- `districts` (20 rows)
- `party_types` (4 rows)
- `login_activity` (3 rows)
- And 34 more tables for your DMS system

## Security Alert! 🔒

The security advisor found that **all 40 tables have RLS (Row Level Security) disabled**. This means your data is currently exposed via the API without protection.

**Recommendation:** Enable RLS on your tables to secure your data.

## Example Usage

### 1. List All Tables
```typescript
// Using the Supabase power through Kiro
kiroPowers.use({
  powerName: "supabase-hosted",
  serverName: "supabase",
  toolName: "list_tables",
  arguments: {
    project_id: "nsdmqbnfnauznyksxckh",
    schemas: ["public"],
    verbose: false
  }
})
```

### 2. Execute SQL Query
```typescript
kiroPowers.use({
  powerName: "supabase-hosted",
  serverName: "supabase",
  toolName: "execute_sql",
  arguments: {
    project_id: "nsdmqbnfnauznyksxckh",
    query: "SELECT * FROM users LIMIT 5"
  }
})
```

### 3. Apply a Migration
```typescript
kiroPowers.use({
  powerName: "supabase-hosted",
  serverName: "supabase",
  toolName: "apply_migration",
  arguments: {
    project_id: "nsdmqbnfnauznyksxckh",
    name: "enable_rls_on_users",
    query: `
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      
      CREATE POLICY "Users can view their own data"
        ON users FOR SELECT
        USING (auth.uid() = id);
    `
  }
})
```

### 4. Get Security Advisors
```typescript
kiroPowers.use({
  powerName: "supabase-hosted",
  serverName: "supabase",
  toolName: "get_advisors",
  arguments: {
    project_id: "nsdmqbnfnauznyksxckh",
    type: "security"
  }
})
```

### 5. Create a Development Branch
```typescript
// First get the cost
kiroPowers.use({
  powerName: "supabase-hosted",
  serverName: "supabase",
  toolName: "get_cost",
  arguments: {
    type: "branch",
    organization_id: "your-org-id"
  }
})

// Then create the branch
kiroPowers.use({
  powerName: "supabase-hosted",
  serverName: "supabase",
  toolName: "create_branch",
  arguments: {
    project_id: "nsdmqbnfnauznyksxckh",
    name: "feature-new-auth",
    confirm_cost_id: "cost-confirmation-id"
  }
})
```

## Next Steps

1. **Enable RLS**: Secure your tables by enabling Row Level Security
2. **Sync Migrations**: Run `npx supabase migration fetch --yes` to sync remote migrations locally
3. **Create Migrations**: Use `apply_migration` to make schema changes
4. **Generate Types**: After schema changes, regenerate types with the power
5. **Use Branches**: Test changes safely in development branches before merging to production

## Useful Commands

```bash
# List projects
npx supabase projects list

# Check project status
npx supabase status

# Sync remote migrations
npx supabase migration fetch --yes

# Generate types (via power is easier)
# Or manually: npx supabase gen types --linked > src/types/supabase.ts
```

## Documentation

For more details, check out:
- [Supabase Documentation](https://supabase.com/docs)
- [Row Level Security Guide](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Database Migrations](https://supabase.com/docs/guides/cli/local-development#database-migrations)
