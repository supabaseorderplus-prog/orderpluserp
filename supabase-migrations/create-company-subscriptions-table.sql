-- Create company_subscriptions table for managing company subscription plans
-- Run this migration in Supabase SQL Editor

-- First, check if table exists and create if not
CREATE TABLE IF NOT EXISTS company_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID UNIQUE NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    plan_name VARCHAR(100) DEFAULT 'STARTER',
    plan_tier VARCHAR(50) DEFAULT 'BASIC',
    started_at DATE DEFAULT CURRENT_DATE,
    expires_at DATE,
    amount_monthly DECIMAL(10, 2) DEFAULT 0,
    status VARCHAR(50) DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_company_id ON company_subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_status ON company_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_expires_at ON company_subscriptions(expires_at);

-- Enable RLS (Row Level Security)
ALTER TABLE company_subscriptions ENABLE ROW LEVEL SECURITY;

-- Create policy to allow SUPER_ADMIN to manage all subscriptions
CREATE POLICY "SUPER_ADMIN can manage all subscriptions" ON company_subscriptions
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users
            WHERE users.id = auth.uid()
            AND users.role = 'SUPER_ADMIN'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM users
            WHERE users.id = auth.uid()
            AND users.role = 'SUPER_ADMIN'
        )
    );

-- Create policy to allow companies to read their own subscription
CREATE POLICY "Companies can read own subscription" ON company_subscriptions
    FOR SELECT
    TO authenticated
    USING (
        company_id = (
            SELECT party_id FROM users WHERE users.id = auth.uid()
        )
    );

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_company_subscriptions_updated_at
    BEFORE UPDATE ON company_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions
GRANT ALL ON company_subscriptions TO authenticated;
GRANT ALL ON company_subscriptions TO service_role;