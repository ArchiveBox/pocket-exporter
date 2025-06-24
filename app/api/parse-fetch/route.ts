import { NextRequest, NextResponse } from 'next/server';

interface ParsedAuth {
  cookies: Record<string, string>;
  cookieString: string;
  headers: Record<string, string>;
}

export async function POST(request: NextRequest) {
  try {
    const { fetchCode } = await request.json();

    if (!fetchCode || typeof fetchCode !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid fetch code' },
        { status: 400 }
      );
    }

    // Extract the headers object using regex
    const headersMatch = fetchCode.match(/"headers"\s*:\s*(\{[\s\S]*?\})\s*(?:,\s*"body"|,\s*"method"|\})/);
    if (!headersMatch) {
      return NextResponse.json(
        { error: 'Could not find headers in the fetch request' },
        { status: 400 }
      );
    }

    // Parse the headers object
    const headersStr = headersMatch[1];
    let headers: Record<string, string>;
    try {
      // Use Function constructor to safely evaluate the object
      headers = new Function('return ' + headersStr)();
    } catch (e) {
      return NextResponse.json(
        { error: 'Error parsing headers' },
        { status: 400 }
      );
    }

    // Extract cookies
    const cookieHeader = headers.cookie || headers.Cookie;
    if (!cookieHeader) {
      return NextResponse.json(
        { error: 'No cookie header found' },
        { status: 400 }
      );
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
      return NextResponse.json(
        { 
          error: 'Missing required authentication cookies',
          details: {
            PHPSESSID: !!cookies.PHPSESSID,
            AUTH_BEARER_default: !!cookies.AUTH_BEARER_default
          }
        },
        { status: 400 }
      );
    }

    // Prepare response
    const parsedAuth: ParsedAuth = {
      cookies,
      cookieString: cookieHeader,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'cookie')
      )
    };

    return NextResponse.json({
      success: true,
      data: parsedAuth,
      summary: {
        PHPSESSID: !!cookies.PHPSESSID,
        AUTH_BEARER_DEFAULT: !!cookies.AUTH_BEARER_default,
        cookieLength: cookieHeader.length,
        headerCount: Object.keys(headers).length - 1
      }
    });

  } catch (error) {
    console.error('Parse fetch error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}