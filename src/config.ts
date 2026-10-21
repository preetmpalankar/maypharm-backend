import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  SUPABASE_URL: z.url({ error: 'SUPABASE_URL must be the project API URL.' }),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string({ error: 'SUPABASE_SERVICE_ROLE_KEY is required.' })
    .min(20, 'SUPABASE_SERVICE_ROLE_KEY looks truncated.'),
  CORS_ORIGINS: z.string().default('http://localhost:3001'),
  ASSET_BUCKET: z.string().min(1).default('maypharm-admin-assets'),
});

export type AppConfig = z.infer<typeof envSchema> & {
  corsOrigins: string[];
  isProduction: boolean;
};

let cached: AppConfig | undefined;

/**
 * Reads and validates the environment once. Outside production a local .env
 * is loaded first so `pnpm start` works without exporting variables by hand;
 * values already present in the environment always win.
 */
export function loadConfig(): AppConfig {
  if (cached) {
    return cached;
  }

  if (process.env.NODE_ENV !== 'production') {
    const envPath = resolve(process.cwd(), '.env');

    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
    }
  }

  const parsed = envSchema.safeParse({
    ...process.env,
    SUPABASE_URL:
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid API environment configuration:\n${problems}`);
  }

  cached = {
    ...parsed.data,
    SUPABASE_URL: parsed.data.SUPABASE_URL.replace(/\/+$/, ''),
    corsOrigins: parsed.data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    isProduction: parsed.data.NODE_ENV === 'production',
  };

  return cached;
}
