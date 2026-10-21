import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from './config';

/** Service-role Supabase client. Only ever used server-side, after auth checks. */
@Injectable()
export class SupabaseService {
  readonly admin: SupabaseClient;
  readonly url: string;
  readonly bucket: string;

  constructor() {
    const config = loadConfig();

    this.url = config.SUPABASE_URL;
    this.bucket = config.ASSET_BUCKET;
    this.admin = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    ) as SupabaseClient;
  }
}
