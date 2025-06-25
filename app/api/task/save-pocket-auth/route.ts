import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

interface ParsedAuth {
  cookies: Record<string, string>;
  cookieString: string;
  headers: Record<string, string>;
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
  
  // Prepare response
  return {
    cookies,
    cookieString: cookieHeader,
    headers: Object.fromEntries(
      Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'cookie')
    )
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    let cookieString: string;
    let headers: Record<string, string>;
    const oldSessionId = body.oldSessionId; // Get the old session ID if updating
    
    console.log('Save auth request:', { 
      hasOldSessionId: !!oldSessionId, 
      oldSessionId,
      hasFetchCode: !!body.fetchCode 
    });
    
    // Check if we received a fetch code or already parsed data
    if (body.fetchCode) {
      // Parse the fetch code
      const parsed = parseFetchCode(body.fetchCode);
      cookieString = parsed.cookieString;
      headers = parsed.headers;
    } else if (body.cookieString && body.headers) {
      // Already parsed data
      cookieString = body.cookieString;
      headers = body.headers;
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
    
    console.log('Generated session ID:', sessionId);
    console.log('Session IDs match?', sessionId === oldSessionId);
    
    // Get the session URL from the request
    const sessionUrl = request.headers.get('referer') || '';

    // Check if session already exists on disk
    const existingSession = await exportStore.getSession(sessionId);
    
    // Create or update session with auth data
    await exportStore.createOrUpdateSession(sessionId, {
      cookieString,
      headers
    }, sessionUrl.split('?')[0] + `?session=${sessionId}`);

    console.log('Before symlink check:', { oldSessionId, sessionId, condition: oldSessionId && oldSessionId !== sessionId });
    
    // Handle bearer token change - create symlink from new session to old
    if (oldSessionId && oldSessionId !== sessionId) {
      console.log(`Bearer token changed - attempting to create symlink from ${sessionId} to ${oldSessionId}`);
      const sessionsDir = path.join(process.cwd(), 'sessions');
      const oldSessionPath = path.join(sessionsDir, oldSessionId);
      const newSessionPath = path.join(sessionsDir, sessionId);
      
      console.log(`Old session path: ${oldSessionPath}`);
      console.log(`New session path: ${newSessionPath}`);
      
      try {
        // Check if old session exists and is a real directory
        const oldPathStats = await fs.promises.lstat(oldSessionPath).catch(() => null);
        console.log(`Old path stats:`, oldPathStats ? `exists, isDirectory: ${oldPathStats.isDirectory()}` : 'does not exist');
        
        if (oldPathStats && oldPathStats.isDirectory()) {
          // Check if new session path already exists
          const newPathStats = await fs.promises.lstat(newSessionPath).catch(() => null);
          console.log(`New path stats:`, newPathStats ? `exists, isDirectory: ${newPathStats.isDirectory()}, isSymlink: ${newPathStats.isSymbolicLink()}` : 'does not exist');
          
          if (newPathStats) {
            if (newPathStats.isSymbolicLink()) {
              // If it's already a symlink, remove it to recreate
              console.log(`Removing existing symlink at ${newSessionPath}`);
              await fs.promises.unlink(newSessionPath);
            } else if (newPathStats.isDirectory()) {
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
          await fs.promises.symlink(`./${oldSessionId}`, newSessionPath, 'dir');
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
      sessionId,
      existingSession: !!existingSession,
      message: existingSession ? 'Updated authentication for existing session' : 'Created new session'
    });

  } catch (error: any) {
    console.error('Save auth error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}