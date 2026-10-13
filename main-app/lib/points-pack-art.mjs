// The uploaded banners contain fixed points and USD prices. The catalog still
// owns all sale values; mismatches fall back to the normal server-rendered text.
const artwork = new Map([
  ['5000:500', 'starter'],
  ['10000:1000', 'regular'],
  ['27500:2500', 'pro'],
  ['57500:5000', 'max'],
  ['120000:10000', 'ultimate'],
]);

export function pointPackArtwork(pack) {
  if (pack?.currency !== 'USD' || typeof pack.points !== 'string'
    || typeof pack.priceMinor !== 'string') return null;
  const name = artwork.get(`${pack.points}:${pack.priceMinor}`);
  return name ? `/points-packs/${name}.png` : null;
}
