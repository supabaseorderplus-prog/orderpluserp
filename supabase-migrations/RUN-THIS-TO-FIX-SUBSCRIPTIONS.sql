-- ============================================================
-- RUN THIS IN SUPABASE SQL EDITOR TO FIX SUBSCRIPTION SAVING
-- ============================================================

-- 1. Create subscription_plan_templates table (if not exists)
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

-- 2. Create company_subscriptions table (if not exists)
CREATE TABLE IF NOT EXISTS company_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID UNIQUE NOT NULL,
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

-- 3. Create indexes (safe if already exist)
CREATE INDEX IF NOT EXISTS idx_subscription_plan_templates_is_active ON subscription_plan_templates(is_active);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_company_id ON company_subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_status ON company_subscriptions(status);

-- 4. Enable RLS
ALTER TABLE subscription_plan_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_subscriptions ENABLE ROW LEVEL SECURITY;

-- 5. Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "SUPER_ADMIN can manage all plan templates" ON subscription_plan_templates;
DROP POLICY IF EXISTS "SUPER_ADMIN can manage all subscriptions" ON company_subscriptions;
DROP POLICY IF EXISTS "Companies can read own subscription" ON company_subscriptions;

-- 6. Create permissive policies for service_role (used by Next.js API)
CREATE POLICY "Service role full access on plan_templates" ON subscription_plan_templates
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Service role full access on subscriptions" ON company_subscriptions
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- 7. Create policies for authenticated users (SUPER_ADMIN check)
CREATE POLICY "SUPER_ADMIN can manage all plan templates" ON subscription_plan_templates
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'SUPER_ADMIN'))
    WITH CHECK (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'SUPER_ADMIN'));

CREATE POLICY "SUPER_ADMIN can manage all subscriptions" ON company_subscriptions
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'SUPER_ADMIN'))
    WITH CHECK (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'SUPER_ADMIN'));

-- 8. Grant permissions
GRANT ALL ON subscription_plan_templates TO authenticated;
GRANT ALL ON subscription_plan_templates TO service_role;
GRANT ALL ON company_subscriptions TO authenticated;
GRANT ALL ON company_subscriptions TO service_role;

-- 9. Insert default plan templates (safe if already exist)
INSERT INTO subscription_plan_templates (name, plan_tier, amount_monthly, duration_days, description, features)
VALUES 
    ('Starter', 'BASIC', 0, 365, 'Free tier with basic features', '["Basic dashboard", "Limited products", "Email support"]'::jsonb),
    ('Professional', 'STANDARD', 2999, 365, 'Standard plan for growing businesses', '["Full dashboard", "Unlimited products", "Priority support", "Analytics"]'::jsonb),
    ('Enterprise', 'PRO', 9999, 365, 'Advanced plan for large organizations', '["Everything in Pro", "Custom integrations", "Dedicated support", "Advanced analytics"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Done! Run this in Supabase SQL Editor to create the required tables.