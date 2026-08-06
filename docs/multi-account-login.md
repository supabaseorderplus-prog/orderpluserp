# Multi-Account Login Implementation

## Overview
This feature allows a single phone number to be associated with multiple user accounts across different companies/roles. When a user logs in, they can select which account to use if they have multiple.

## Database Changes Required

### 1. Remove Phone Unique Constraint (if exists)
In Supabase SQL Editor, run:

```sql
-- Check if phone unique constraint exists
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'app_users'::regclass;

-- Remove unique constraint on phone column (if it exists)
-- Replace 'app_users_phone_key' with actual constraint name from above query
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_phone_key;
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_phone_unique;

-- Create a non-unique index for faster phone lookups
CREATE INDEX IF NOT EXISTS idx_app_users_phone ON app_users(phone);
```

### 2. Ensure Email Uniqueness
The email column must remain unique since Supabase Auth uses email for login. Each account must have a unique email.

## How It Works

### Account Creation Flow
1. When creating a user with an existing phone number:
   - System generates a unique email (e.g., `phone_company_suffix@portal.internal`)
   - User can log in with their phone number
   - System looks up all accounts matching that phone
   - If multiple accounts exist, user selects which one to use

### Login Flow
1. User enters phone number + password + portal selection
2. System queries `app_users` for all accounts with matching phone
3. If single account: proceed to authenticate
4. If multiple accounts: show account picker
5. User selects account, system uses that account's email for Supabase Auth
6. After successful auth, user is redirected to appropriate dashboard

### API Endpoints

#### GET /api/v1/auth/companies?phone=XXX&role=SALESMAN
Returns all accounts for a phone number, optionally filtered by role/portal.

Response:
```json
{
  "success": true,
  "data": {
    "accounts": [
      {
        "userId": "uuid",
        "name": "John Doe",
        "email": "john@company1.com",
        "phone": "9876543210",
        "role": "SALESMAN",
        "partyId": "company-uuid-1",
        "companyName": "ABC Company"
      },
      {
        "userId": "uuid2",
        "name": "John Doe",
        "email": "john@company2.com",
        "phone": "9876543210",
        "role": "CNF_USER",
        "partyId": "company-uuid-2",
        "companyName": "XYZ Distributors"
      }
    ],
    "multiple": true,
    "byCompany": {
      "ABC Company": [...],
      "XYZ Distributors": [...]
    },
    "totalCompanies": 2
  }
}
```

#### POST /api/v1/auth/login
Login with phone number. If multiple accounts, returns status 300 with account list.

Request body:
```json
{
  "phone": "9876543210",
  "password": "password123",
  "role": "SALESMAN",
  "userId": "optional-selected-user-id"
}
```

### Frontend (Login Page)
- Account picker shows accounts grouped by company
- Displays role and company name for each account
- User can select which account to use

## Creating New Users with Same Phone

When creating a user with an existing phone number through the admin panel:

1. Use the standard `/api/v1/users` POST endpoint
2. Provide a unique email for each user
3. Phone number can be the same as existing users
4. The `party_id` (company) and `role_id` differentiate the accounts

Example:
```json
{
  "name": "John Doe",
  "email": "john.doe@company2.com",
  "phone": "9876543210",
  "password": "password123",
  "role_id": "role-uuid",
  "party_id": "company-uuid"
}
```

## Portal to Role Mapping

| Portal | Database Role |
|--------|--------------|
| SUPER_ADMIN | SUPER_ADMIN |
| ADMIN | ADMIN |
| SALES_MANAGER | SALES_MANAGER |
| TERRITORY_MANAGER | TERRITORY_MANAGER |
| SALESMAN | SALESMAN |
| CNF_USER | CNF_USER |
| SUPER_DEALER_USER | SUPER_DEALER_USER |
| RETAILER_USER | RETAILER_USER |
| WAREHOUSE_MANAGER | WAREHOUSE_MANAGER |
| ACCOUNTS_MANAGER | ACCOUNTS_MANAGER |
| AUDITOR | AUDITOR |
| DRIVER | SALESMAN (with display_role='DRIVER') |