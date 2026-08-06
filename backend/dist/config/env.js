"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = require("dotenv");
const zod_1 = require("zod");
// Load environment variables from .env file
(0, dotenv_1.config)();
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    PORT: zod_1.z.string().default('4000'),
    DATABASE_URL: zod_1.z.string(),
    REDIS_URL: zod_1.z.string().default('redis://localhost:6379'),
    JWT_ACCESS_SECRET: zod_1.z.string(),
    JWT_REFRESH_SECRET: zod_1.z.string(),
    JWT_ACCESS_EXPIRY: zod_1.z.string().default('15m'),
    JWT_REFRESH_EXPIRY: zod_1.z.string().default('7d'),
    AWS_ACCESS_KEY_ID: zod_1.z.string().optional(),
    AWS_SECRET_ACCESS_KEY: zod_1.z.string().optional(),
    AWS_S3_BUCKET: zod_1.z.string().optional(),
    AWS_REGION: zod_1.z.string().default('ap-south-1'),
    CORS_ORIGIN: zod_1.z.string().default('http://localhost:3000'),
    COMPANY_GSTIN: zod_1.z.string().default('19AABCH0000A1Z5'),
    COMPANY_NAME: zod_1.z.string().default('HomeTech Chemical Pvt. Ltd.'),
    COMPANY_ADDRESS: zod_1.z.string().default('Salt Lake, Sector V, Kolkata, West Bengal 700091'),
    COMPANY_STATE: zod_1.z.string().default('West Bengal'),
    COMPANY_STATE_CODE: zod_1.z.string().default('19'),
});
function loadEnv() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
        process.exit(1);
    }
    return parsed.data;
}
exports.env = loadEnv();
//# sourceMappingURL=env.js.map