-- Create subscription_plan_templates table for managing plan templates
-- Run this migration in Supabase SQL Editor

-- First, check if table exists and create if not
CREATE TABLE IF NOT EXISTS subscription_plan_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    plan_tier VARCHAR(50) DEFAULT 'BASIC',
    amount_monthly DECIMAL(10, 2) DEFAULT 0,
    duration_days INTEGER DEFAULT 365,
    description TEXT,
    features JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_subscription_plan_templates_is_active ON subscription_plan_templates(is_active);
CREATE INDEX IF NOT EXISTS idx_subscription_plan_templates_tier ON subscription_plan_templates(plan_tier);

-- Enable RLS (Row Level Security)
ALTER TABLE subscription_plan_templates ENABLE ROW LEVEL SECURITY;

-- Create policy to allow SUPER_ADMIN to manage all templates
CREATE POLICY "SUPER_ADMIN can manage all plan templates" ON subscription_plan_templates
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

-- Create trigger to update updated_at timestamp (reuse existing function if exists)
CREATE TRIGGER update_subscription_plan_templates_updated_at
    BEFORE UPDATE ON subscription_plan_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions
GRANT ALL ON subscription_plan_templates TO authenticated;
GRANT ALL ON subscription_plan_templates TO service_role;

-- Insert some default plan templates
INSERT INTO subscription_plan_templates (name, plan_tier, amount_monthly, duration_days, description, features)
VALUES 
    ('Starter', 'BASIC', 0, 365, 'Free tier with basic features', '["Basic dashboard", "Limited products", "Email support"]'::jsonb),
    ('Professional', 'STANDARD', 2999, 365, 'Standard plan for growing businesses', '["Full dashboard", "Unlimited products", "Priority support", "Analytics"]'::jsonb),
    ('Enterprise', 'PRO', 9999, 365, 'Advanced plan for large organizations', '["Everything in Pro", "Custom integrations", "Dedicated support", "Advanced analytics"]'::jsonb)
ON CONFLICT DO NOTHING;