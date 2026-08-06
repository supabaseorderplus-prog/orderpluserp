import { config } from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
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
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
