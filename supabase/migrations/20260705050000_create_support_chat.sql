-- Company-scoped support inbox for party <-> administrator conversations.
-- Ticket numbers are globally serial and category-prefixed (A000001, B000002...).

CREATE SEQUENCE IF NOT EXISTS public.support_ticket_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.support_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  ticket_number text UNIQUE,
  subject text NOT NULL,
  category text NOT NULL DEFAULT 'GENERAL'
    CHECK (category IN ('ORDER', 'PAYMENT', 'PRODUCT', 'TECHNICAL', 'GENERAL')),
  priority text NOT NULL DEFAULT 'NORMAL'
    CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'WAITING', 'RESOLVED', 'CLOSED')),
  created_by_user_id uuid NOT NULL,
  created_by_name text NOT NULL,
  created_by_role text NOT NULL,
  assigned_to_user_id uuid,
  assigned_to_name text,
  party_unread_count integer NOT NULL DEFAULT 0 CHECK (party_unread_count >= 0),
  admin_unread_count integer NOT NULL DEFAULT 0 CHECK (admin_unread_count >= 0),
  last_message_preview text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  party_last_read_at timestamptz,
  admin_last_read_at timestamptz,
  access_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  closed_at timestamptz,
  closed_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  sender_user_id uuid,
  sender_name text NOT NULL,
  sender_role text NOT NULL,
  sender_type text NOT NULL CHECK (sender_type IN ('PARTY', 'ADMIN', 'SYSTEM')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  message_type text NOT NULL DEFAULT 'TEXT'
    CHECK (message_type IN ('TEXT', 'SYSTEM', 'WHATSAPP')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_conversations_company_status
  ON public.support_conversations(company_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_conversations_party
  ON public.support_conversations(party_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_conversations_creator
  ON public.support_conversations(created_by_user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation
  ON public.support_messages(conversation_id, created_at);

CREATE OR REPLACE FUNCTION public.assign_support_ticket_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prefix text;
BEGIN
  IF NEW.ticket_number IS NULL OR btrim(NEW.ticket_number) = '' THEN
    prefix := CASE NEW.category
      WHEN 'ORDER' THEN 'A'
      WHEN 'PAYMENT' THEN 'B'
      WHEN 'PRODUCT' THEN 'C'
      WHEN 'TECHNICAL' THEN 'D'
      ELSE 'E'
    END;
    NEW.ticket_number := prefix || lpad(nextval('public.support_ticket_number_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_support_ticket_number ON public.support_conversations;
CREATE TRIGGER trg_assign_support_ticket_number
BEFORE INSERT ON public.support_conversations
FOR EACH ROW EXECUTE FUNCTION public.assign_support_ticket_number();

CREATE OR REPLACE FUNCTION public.touch_support_conversation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_support_conversation ON public.support_conversations;
CREATE TRIGGER trg_touch_support_conversation
BEFORE UPDATE ON public.support_conversations
FOR EACH ROW EXECUTE FUNCTION public.touch_support_conversation();

ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- API routes use the service role and enforce company/user scope. Realtime is
-- optional; guarded so repeated migrations remain safe.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.support_conversations;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.support_messages;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
