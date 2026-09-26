import { authenticateLauncherRequest } from '@/lib/launcher-auth';
import { pointsEnabled } from '@/lib/points';
import { createPointsHandler } from '@/lib/points-http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createPointsHandler({ authenticate: authenticateLauncherRequest, isEnabled: pointsEnabled, kind: 'summary' });
