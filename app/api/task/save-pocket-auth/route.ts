import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
    const oldSessionId = body.oldSessionId; // Get the old session ID if updating
    
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

    // Extract AUTH_BEARER token from cookies
    const authBearer = cookieString.split('AUTH_BEARER_default=')[1]?.split(';')[0];
    
    if (!authBearer) {
      return NextResponse.json(
        { success: false, error: 'Could not extract AUTH_BEARER token from cookies' },
        { status: 400 }
      );
    }

    // Create a stable session ID by hashing the AUTH_BEARER token
    const bearerHash = crypto
      .createHash('sha256')
      .update(authBearer)
      .digest('hex');
    
    // Create a readable session ID from the hash
    const sessionId = `pocket-${bearerHash.substring(0, 8)}-${bearerHash.substring(bearerHash.length - 8)}`;
    
    // Get the session URL from the request
    const sessionUrl = request.headers.get('referer') || '';

    // Create or update session with auth data
    await exportStore.createOrUpdateSession(sessionId, {
      cookieString,
      headers
    }, sessionUrl.split('?')[0] + `?session=${sessionId}`);

    // Handle bearer token change - create symlink from new session to old
    if (oldSessionId && oldSessionId !== sessionId) {
      const sessionsDir = path.join(process.cwd(), 'sessions');
      const oldSessionPath = path.join(sessionsDir, oldSessionId);
      const newSessionPath = path.join(sessionsDir, sessionId);
      
      try {
        // Check if old session exists and is a real directory
        if (fs.existsSync(oldSessionPath) && fs.lstatSync(oldSessionPath).isDirectory()) {
          // Check if new session path already exists
          if (fs.existsSync(newSessionPath)) {
            const stats = fs.lstatSync(newSessionPath);
            
            if (stats.isSymbolicLink()) {
              // If it's already a symlink, remove it to recreate
              fs.unlinkSync(newSessionPath);
            } else if (stats.isDirectory()) {
              // If it's a real directory, don't overwrite it
              console.log(`Warning: ${newSessionPath} is a real directory, not creating symlink`);
              return NextResponse.json({ 
                success: true,
                sessionId,
                warning: 'New session path is a real directory, not overwriting'
              });
            }
          }
          
          // Create symlink from new to old (new session points to old session data)
          fs.symlinkSync(`./${oldSessionId}`, newSessionPath, 'dir');
          console.log(`Created symlink: ${sessionId} -> ${oldSessionId}`);
        } else {
          console.log(`Old session ${oldSessionId} does not exist or is not a directory`);
        }
      } catch (error) {
        console.error('Error creating symlink:', error);
        // Not critical, so we continue
      }
    }

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