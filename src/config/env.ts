import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  // TODO: Add real Amazon app credentials in .env before connecting live seller accounts.
  AMAZON_LWA_CLIENT_ID: z.string().min(1),
  AMAZON_LWA_CLIENT_SECRET: z.string().min(1),
  AMAZON_APP_ID: z.string().min(1),
  AMAZON_AUTH_BASE_URL: z.string().url().default("https://sellercentral.amazon.com"),
  AMAZON_LWA_TOKEN_URL: z.string().url().default("https://api.amazon.com/auth/o2/token"),
  AMAZON_SP_API_REGION: z.enum(["NA", "EU", "FE"]).default("NA")
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment variables:");
  console.error(parsedEnv.error.flatten().fieldErrors);
  throw new Error("Environment validation failed. Check your .env file.");
}

export const env = parsedEnv.data;
