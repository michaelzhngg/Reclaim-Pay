import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const token = request.cookies.get('session')?.value;
  const { pathname } = request.nextUrl;

  // Public paths: landing, login, the password link pages, API, and PWA/static assets bypass the auth gate
  if (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname === '/forgot-password' ||
    pathname === '/set-password' ||
    pathname === '/reset-password' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/images/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.json' ||
    pathname === '/sw.js'
  ) {
    return NextResponse.next();
  }

  // Redirect to login if no token is found
  if (!token) {
    console.log("no token, redirect");
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // If authenticated, allow access
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|manifest.json|sw.js|icons|login|forgot-password|set-password|reset-password).*)'],
};
