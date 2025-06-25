import { NextRequest, NextResponse } from 'next/server';

type RouteHandler = (request: NextRequest, context?: any) => Promise<Response> | Response;

export function withTiming(handler: RouteHandler): RouteHandler {
  return async (request: NextRequest, context?: any) => {
    const start = Date.now();
    
    // Get client IP - check multiple headers in order of preference
    const ip = request.headers.get('cf-connecting-ip') ||  // Cloudflare
               request.headers.get('x-forwarded-for')?.split(',')[0] || // Standard proxy header (first IP)
               request.headers.get('x-real-ip') || // Nginx
               request.headers.get('x-client-ip') || // Apache
               'Unknown';
    
    // Get request details
    const method = request.method;
    const { pathname, search } = request.nextUrl;
    const url = `${pathname}${search}`;
    
    try {
      // Execute the actual handler
      const response = await handler(request, context);
      
      // Calculate duration
      const duration = Date.now() - start;
      
      // Get status code
      const status = response.status;
      
      // Log the request with timing and status
      console.log(`[${new Date().toISOString()}] ${ip} - ${method} ${url} - ${status} - ${duration}ms`);
      
      // Add timing header to response
      const headers = new Headers(response.headers);
      headers.set('x-response-time', `${duration}ms`);
      
      // Return response with timing header
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      // Calculate duration even on error
      const duration = Date.now() - start;
      
      // Log error
      console.error(`[${new Date().toISOString()}] ${ip} - ${method} ${url} - 500 - ${duration}ms - Error: ${error}`);
      
      // Re-throw the error to maintain original behavior
      throw error;
    }
  };
}