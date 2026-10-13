// Builds with fake credentials only. No deployment or production access.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
  windowsHide: true, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: 'https://points-test.invalid', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'local-test-publishable-key',
    SUPABASE_SECRET_KEY: 'local-test-secret-key', POINTS_ITCH_CHECKOUT_ENABLED: 'false', POINTS_ITCH_CLAIMS_ENABLED: 'false' },
});
const [code] = await once(child, 'exit');
process.exitCode = code ?? 1;
