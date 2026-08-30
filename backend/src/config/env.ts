import { config } from 'dotenv';
import { resolve } from 'path';
import { z } from 'zod';

// Local development keeps shared Supabase credentials in the root Next.js env.
// Docker/production injects its own environment and does not need this file.
if (process.env.NODE_ENV !== 'production') {
  config({ path: resolve(process.cwd(), '../.env.local') });
}

// Load backend-only settings and retain existing values from the shared env.
config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('4000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().default('ap-south-1'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  COMPANY_GSTIN: z.string().default('19AABCH0000A1Z5'),
  COMPANY_NAME: z.string().default('HomeTech Chemical Pvt. Ltd.'),
  COMPANY_ADDRESS: z.string().default('Salt Lake, Sector V, Kolkata, West Bengal 700091'),
  COMPANY_STATE: z.string().default('West Bengal'),
  COMPANY_STATE_CODE: z.string().default('19'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse({
    ...process.env,
    // Prefer the current shared Supabase project over a stale backend-only URL.
    DATABASE_URL: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
  });
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

// Prisma reads DATABASE_URL directly from process.env during initialization.
process.env.DATABASE_URL = env.DATABASE_URL;
