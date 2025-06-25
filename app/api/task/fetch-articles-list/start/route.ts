import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import { exportStore } from '@/lib/export-store';

export async function POST(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('sessionId');

    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const session = exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Session not found' },
        { status: 404 }
      );
    }

    if (!session.auth) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Check if a fetch task is already running
    if (session.currentFetchTask?.status === 'running') {
      return NextResponse.json(
        { success: false, error: 'Fetch task is already running' },
        { status: 409 }
      );
    }

    // Update fetch task status to running
    exportStore.updateFetchTask(sessionId, {
      status: 'running',
      startedAt: new Date(),
      count: 0,
      total: 0,
      error: undefined,
      rateLimitedAt: undefined,
      rateLimitRetryAfter: undefined
    });

    // Start the background task
    const scriptPath = path.join(process.cwd(), 'lib', 'fetch-articles-task.ts');
    const child = spawn('tsx', [scriptPath, sessionId], {
      detached: true,
      stdio: 'inherit', // Forward stdio to parent console
      env: {
        ...process.env,
        SESSION_ID: sessionId,
        NODE_ENV: process.env.NODE_ENV
      }
    });

    child.unref();

    // Update the PID in the session
    exportStore.updateFetchTask(sessionId, {
      pid: child.pid
    });

    console.log(`Started fetch task for session ${sessionId} with PID ${child.pid}`);

    return NextResponse.json({ 
      success: true,
      pid: child.pid
    });

  } catch (error) {
    console.error('Start fetch task error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}