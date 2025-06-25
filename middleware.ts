import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Get client IP - check multiple headers in order of preference
  const ip = request.headers.get('cf-connecting-ip') ||  // Cloudflare
             request.headers.get('x-forwarded-for')?.split(',')[0] || // Standard proxy header (first IP)
             request.headers.get('x-real-ip') || // Nginx
             request.headers.get('x-client-ip') || // Apache
             request.ip || // Next.js detected IP
             'Unknown';
  
  // Get request details
  const method = request.method;
  const { pathname, search } = request.nextUrl;
  
  // Log the request
  console.log(`[${new Date().toISOString()}] ${ip} - ${method} ${pathname}${search}`);
  
  return NextResponse.next();
}

// Configure which paths the middleware runs on
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
};