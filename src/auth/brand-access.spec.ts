import { NotFoundException } from '@nestjs/common';
import type { SupabaseService } from '../supabase.service';
import type { Principal } from './auth.service';
import {
  BrandAccessService,
  visibleContentFilter,
} from './brand-access.service';

const person = (role: Principal['role'], id = 'user-1'): Principal => ({
  id,
  email: `${id}@maypharm.com`,
  fullName: id,
  role,
  status: 'active',
});

/** Two restricted brands; user-1 has been given brand-a. */
function fakeSupabase() {
  const calls = { brands: 0 };
  const from = (table: string) => ({
    select: () => ({
      eq: (_column: string, value: string) => {
        if (table === 'brands') {
          calls.brands += 1;
          return Promise.resolve({
            data: [{ id: 'brand-a' }, { id: 'brand-b' }],
            error: null,
          });
        }
        return Promise.resolve({
          data: value === 'user-1' ? [{ brand_id: 'brand-a' }] : [],
          error: null,
        });
      },
    }),
  });
  return { service: { admin: { from } } as unknown as SupabaseService, calls };
}

describe('brand access', () => {
  it('hides restricted brands a person has not been given', async () => {
    const { service } = fakeSupabase();
    const access = new BrandAccessService(service);

    await expect(
      access.hiddenBrandIds(person('sales', 'user-1')),
    ).resolves.toEqual(['brand-b']);
    await expect(
      access.hiddenBrandIds(person('medical', 'user-2')),
    ).resolves.toEqual(['brand-a', 'brand-b']);
  });

  it('never hides anything from admins', async () => {
    const { service, calls } = fakeSupabase();
    await expect(
      new BrandAccessService(service).hiddenBrandIds(person('admin')),
    ).resolves.toEqual([]);
    expect(calls.brands).toBe(0);
  });

  it('answers a hidden brand with a 404 and lets unbranded content through', async () => {
    const access = new BrandAccessService(fakeSupabase().service);
    await expect(
      access.assertVisible(person('sales'), 'brand-b'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      access.assertVisible(person('sales'), 'brand-a'),
    ).resolves.toBeUndefined();
    await expect(
      access.assertVisible(person('sales'), null),
    ).resolves.toBeUndefined();
  });

  it('caches per person until an admin changes access', async () => {
    const { service, calls } = fakeSupabase();
    const access = new BrandAccessService(service);
    await access.hiddenBrandIds(person('sales'));
    await access.hiddenBrandIds(person('sales'));
    expect(calls.brands).toBe(1);
    access.invalidate();
    await access.hiddenBrandIds(person('sales'));
    expect(calls.brands).toBe(2);
  });

  it('keeps unbranded content visible in the list filter', () => {
    expect(visibleContentFilter([])).toBeNull();
    expect(visibleContentFilter(['a', 'b'])).toBe(
      'brand_id.is.null,brand_id.not.in.(a,b)',
    );
  });
});
