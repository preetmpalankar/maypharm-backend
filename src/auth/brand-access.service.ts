import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase.service';
import type { Principal } from './auth.service';

/** Short, so a change of access is felt quickly; admin changes also clear it at once. */
const cacheTtlMs = 15_000;

/**
 * Which brands a person may see. A brand is open to everyone unless an admin
 * restricts it to chosen people; a restricted brand, its content and its
 * files are hidden from everyone else. Admins see everything.
 *
 * Member routes ask for the brands to hide (usually none) and filter with it,
 * so the common case costs nothing extra.
 */
@Injectable()
export class BrandAccessService {
  private readonly cache = new Map<
    string,
    { hidden: string[]; expiresAt: number }
  >();

  constructor(private readonly supabase: SupabaseService) {}

  /** Ids of the restricted brands this person has not been given. */
  async hiddenBrandIds(principal: Principal): Promise<string[]> {
    if (principal.role === 'admin') return [];

    const cached = this.cache.get(principal.id);
    if (cached && cached.expiresAt > Date.now()) return cached.hidden;

    const db = this.supabase.admin;
    const [restricted, granted] = await Promise.all([
      db.from('brands').select('id').eq('access_mode', 'restricted'),
      db.from('brand_access').select('brand_id').eq('user_id', principal.id),
    ]);
    if (restricted.error) throw restricted.error;
    if (granted.error) throw granted.error;

    const allowed = new Set(
      ((granted.data ?? []) as { brand_id: string }[]).map(
        (row) => row.brand_id,
      ),
    );
    const hidden = ((restricted.data ?? []) as { id: string }[])
      .map((row) => row.id)
      .filter((id) => !allowed.has(id));

    this.cache.set(principal.id, {
      hidden,
      expiresAt: Date.now() + cacheTtlMs,
    });
    return hidden;
  }

  /** Throws a 404 (the same as a missing record) when the brand is hidden from this person. */
  async assertVisible(
    principal: Principal,
    brandId: string | null | undefined,
  ) {
    if (!brandId) return;
    const hidden = await this.hiddenBrandIds(principal);
    if (hidden.includes(brandId))
      throw new NotFoundException('Content not available.');
  }

  /** Called whenever an admin changes a brand's access. */
  invalidate() {
    this.cache.clear();
  }
}

/**
 * The PostgREST filter that keeps content of hidden brands out of a query
 * (content without a brand stays visible). Null when nothing is hidden.
 */
export function visibleContentFilter(hidden: string[]) {
  return hidden.length
    ? `brand_id.is.null,brand_id.not.in.(${hidden.join(',')})`
    : null;
}
