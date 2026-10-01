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
  AMAZON_SP_API_REGION: z.enum(["NA", "EU", "FE"]).default("NA"),
  AMAZON_ADS_CLIENT_ID: z.string().optional(),
  AMAZON_ADS_CLIENT_SECRET: z.string().optional(),
  AMAZON_ADS_REDIRECT_URI: z.string().optional(),
  AMAZON_ADS_REGION: z.enum(["NA", "EU", "FE"]).default("NA"),
  SP_API_LWA_CLIENT_ID: z.string().optional(),
  SP_API_LWA_CLIENT_SECRET: z.string().optional(),
  SP_API_APPLICATION_ID: z.string().optional(),
  SP_API_REGION: z.enum(["NA", "EU", "FE"]).optional(),
  SP_API_MARKETPLACE_ID: z.string().default("A21TJRUUN4KGV"),
  SP_API_REDIRECT_URI: z.string().optional(),
  SP_API_REFRESH_TOKEN: z.string().optional(),
  SP_API_AMAZON_SELLER_ID: z.string().optional(),
  SP_API_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  SP_API_AWS_ACCESS_KEY_ID: z.string().optional(),
  SP_API_AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SP_API_AWS_SESSION_TOKEN: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  // Founder login. Login stays OFF until APP_PASSWORD is set. AUTH_SECRET is an optional extra
  // random string mixed into the token signing key.
  APP_PASSWORD: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  // AI Gateway: only used when a seller explicitly enables AI calls in settings (default OFF).
  // Provider: OpenAI (Chat Completions API). If OpenAI ever rejects OPENAI_MODEL with
  // "model not found," check the exact current model id at platform.openai.com and update this.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.6-luna")
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment variables:");
  console.error(parsedEnv.error.flatten().fieldErrors);
  throw new Error("Environment validation failed. Check your .env file.");
}

export const env = parsedEnv.data;
