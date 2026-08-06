-- Create beat_routes table for tracking/soutes management
-- Run this in Supabase SQL Editor

-- Create beat_routes table
CREATE TABLE IF NOT EXISTS public.beat_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  salesman_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  company_id UUID REFERENCES public.parties(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create route_stops table
CREATE TABLE IF NOT EXISTS public.route_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL REFERENCES public.beat_routes(id) ON DELETE CASCADE,
  party_id UUID REFERENCES public.parties(id) ON DELETE SET NULL,
  sequence INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_beat_routes_company ON public.beat_routes(company_id);
CREATE INDEX IF NOT EXISTS idx_beat_routes_salesman ON public.beat_routes(salesman_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON public.route_stops(route_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_party ON public.route_stops(party_id);

-- Enable RLS
ALTER TABLE public.beat_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_stops ENABLE ROW LEVEL SECURITY;

-- RLS Policies for beat_routes
CREATE POLICY "Users can view routes in their company" ON public.beat_routes
  FOR SELECT USING (
    company_id IN (
      SELECT id FROM public.parties 
      WHERE id = (current_setting('request.jwt.claims', true)::json->>'company_id')::uuid
      OR id IN (SELECT party_id FROM public.users WHERE id = auth.uid())
    )
  );

CREATE POLICY "Service role can manage all routes" ON public.beat_routes
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for route_stops
CREATE POLICY "Users can view stops for routes in their company" ON public.route_stops
  FOR SELECT USING (
    route_id IN (SELECT id FROM public.beat_routes WHERE company_id IS NOT NULL)
  );

CREATE POLICY "Service role can manage all stops" ON public.route_stops
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- Grant permissions
GRANT ALL ON public.beat_routes TO service_role;
GRANT ALL ON public.route_stops TO service_role;

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_beat_routes_updated_at
  BEFORE UPDATE ON public.beat_routes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_route_stops_updated_at
  BEFORE UPDATE ON public.route_stops
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();