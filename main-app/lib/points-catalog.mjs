// Commercial totals include the bonuses. Product IDs are deployment configuration,
// never supplied by a buyer. All money and points stay exact decimal strings.
export const PLAYLIVE_POINT_PACKS = Object.freeze([
  { id: 'starter', name: 'Starter', points: '5000', currency: 'USD', priceMinor: '500', priceLabel: '$5.00' },
  { id: 'regular', name: 'Regular', points: '10000', currency: 'USD', priceMinor: '1000', priceLabel: '$10.00' },
  { id: 'pro', name: 'Pro', points: '27500', currency: 'USD', priceMinor: '2500', priceLabel: '$25.00' },
  { id: 'max', name: 'Max', points: '57500', currency: 'USD', priceMinor: '5000', priceLabel: '$50.00' },
  { id: 'ultimate', name: 'Ultimate', points: '120000', currency: 'USD', priceMinor: '10000', priceLabel: '$100.00' },
].map(Object.freeze));

export function configuredPlayLivePacks(productIds) {
  if (!productIds || typeof productIds !== 'object' || Array.isArray(productIds)
    || Object.keys(productIds).some((id) => !PLAYLIVE_POINT_PACKS.some((pack) => pack.id === id)))
    throw new Error('INVALID_PRODUCT_CONFIGURATION');
  const values = Object.values(productIds);
  if (values.some((id) => typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id))
    || new Set(values).size !== values.length) throw new Error('INVALID_PRODUCT_CONFIGURATION');
  return PLAYLIVE_POINT_PACKS.filter((pack) => productIds[pack.id])
    .map((pack) => ({ ...pack, subProductId: productIds[pack.id], enabled: true }));
}
