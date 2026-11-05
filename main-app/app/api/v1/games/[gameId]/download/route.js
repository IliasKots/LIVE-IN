import { gameDownloadResponse } from '@/lib/game-downloads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  const { gameId } = await params;
  return gameDownloadResponse(request, gameId);
}
