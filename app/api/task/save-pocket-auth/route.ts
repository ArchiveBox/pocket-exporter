import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';

interface ParsedAuth {
  cookies: Record<string, string>;
  cookieString: string;
  headers: Record<string, string>;
  consumerKey?: string;
}

function parseFetchCode(fetchCode: string): ParsedAuth {
  // Extract the headers object using regex
  const headersMatch = fetchCode.match(/"headers"\s*:\s*(\{[\s\S]*?\})\s*(?:,\s*"body"|,\s*"method"|\})/);
  if (!headersMatch) {
    throw new Error('Could not find headers in the fetch request');
  }

  // Parse the headers object
  const headersStr = headersMatch[1];
  let headers: Record<string, string>;
  try {
    // Use Function constructor to safely evaluate the object
    headers = new Function('return ' + headersStr)();
  } catch (e) {
    throw new Error('Error parsing headers');
  }

  // Extract cookies
  const cookieHeader = headers.cookie || headers.Cookie;
  if (!cookieHeader) {
    throw new Error('No cookie header found');
  }

  // Parse cookies
  const cookies: Record<string, string> = {};
  cookieHeader.split('; ').forEach((cookie: string) => {
    const [key, ...valueParts] = cookie.split('=');
    if (key && valueParts.length > 0) {
      cookies[key] = valueParts.join('='); // Handle cases where value contains =
    }
  });

  // Validate required cookies
  if (!cookies.PHPSESSID || !cookies.AUTH_BEARER_default) {
    throw new Error('Missing required authentication cookies');
  }

  // Try to extract consumer_key from URL first
  let consumerKey: string | undefined;
  
  // Extract URL from the fetch request
  const urlMatch = fetchCode.match(/fetch\s*\(\s*["']([^"']+)["']/);
  if (urlMatch) {
    const url = urlMatch[1];
    // Look for consumer_key in URL parameters
    const consumerKeyMatch = url.match(/consumer_key=([^&]+)/);
    if (consumerKeyMatch) {
      consumerKey = consumerKeyMatch[1];
      console.log('Found consumer key in URL:', consumerKey);
    }
  }
  
  // If not found in URL, check for x-consumer-key header
  if (!consumerKey && headers['x-consumer-key']) {
    consumerKey = headers['x-consumer-key'];
    console.log('Found consumer key in x-consumer-key header:', consumerKey);
  }
  
  // If not found in headers, try to extract from the body
  if (!consumerKey) {
    const bodyMatch = fetchCode.match(/"body"\s*:\s*"([^"]+)"/);  
    if (bodyMatch) {
      try {
        // Unescape the JSON string
        const bodyStr = bodyMatch[1].replace(/\\"/g, '"');
        const bodyData = JSON.parse(bodyStr);
        consumerKey = bodyData.consumer_key;
        if (consumerKey) {
          console.log('Found consumer key in request body:', consumerKey);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }
  
  // Prepare response
  return {
    cookies,
    cookieString: cookieHeader,
    headers: Object.fromEntries(
      Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'cookie')
    ),
    consumerKey
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    let cookieString: string;
    let headers: Record<string, string>;
    let consumerKey: string | undefined;
    
    // Check if we received a fetch code or already parsed data
    if (body.fetchCode) {
      // Parse the fetch code
      const parsed = parseFetchCode(body.fetchCode);
      cookieString = parsed.cookieString;
      headers = parsed.headers;
      consumerKey = parsed.consumerKey;
    } else if (body.cookieString && body.headers) {
      // Already parsed data
      cookieString = body.cookieString;
      headers = body.headers;
      consumerKey = body.consumerKey;
    } else {
      return NextResponse.json(
        { success: false, error: 'Missing required auth data' },
        { status: 400 }
      );
    }

    // Extract consumer key from cookies if not already found
    if (!consumerKey) {
      consumerKey = cookieString.split('a95b4b6=')[1]?.split(';')[0] || '';
    }
    
    if (!consumerKey) {
      return NextResponse.json(
        { success: false, error: 'Could not extract consumer key from cookies' },
        { status: 400 }
      );
    }

    // Create a session ID based on consumer key
    const sessionId = `${consumerKey.substring(0, 5)}-${consumerKey.substring(consumerKey.length - 25)}`;
    
    // Get the session URL from the request
    const sessionUrl = request.headers.get('referer') || '';

    // Create or update session with auth data
    exportStore.createOrUpdateSession(sessionId, {
      cookieString,
      headers
    }, sessionUrl.split('?')[0] + `?session=${sessionId}`);

    return NextResponse.json({ 
      success: true,
      sessionId 
    });

  } catch (error: any) {
    console.error('Save auth error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}