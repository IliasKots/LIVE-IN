export function createPointsPacksHandler({ getPacks }) {
  return function GET() {
    try {
      const packs = getPacks();
      return Response.json({ packs, checkoutEnabled: packs.length > 0 }, {
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    } catch {
      return Response.json({ error: 'Points packs are temporarily unavailable' }, {
        status: 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
  };
}
