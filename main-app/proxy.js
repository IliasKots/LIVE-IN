import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

export async function proxy(request) {
  // Redeem proofs must be consumed by the route before auth or page rendering.
  if (request.nextUrl.pathname === '/api/points/itch/redeem') {
    return NextResponse.next({ headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  // Provider webhooks carry no browser session; the route verifies the raw-body signature.
  if (request.nextUrl.pathname === '/api/points/lemonsqueezy/webhook'
    || request.nextUrl.pathname === '/api/points/stripe/webhook') return NextResponse.next();
  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },

        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response = NextResponse.next({
              request,
            });

            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
