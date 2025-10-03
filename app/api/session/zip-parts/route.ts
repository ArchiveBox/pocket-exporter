import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import fs from 'fs';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const session = await exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Get all article IDs
    const allArticleIds = await exportStore.getSessionArticleIds(sessionId);
    const ARTICLES_PER_ZIP = 10000;
    
    // Calculate how many ZIP files we need
    const totalParts = Math.ceil(allArticleIds.length / ARTICLES_PER_ZIP);
    
    // Create download links for each part
    const parts = [];
    for (let i = 0; i < totalParts; i++) {
      const start = i * ARTICLES_PER_ZIP;
      const end = Math.min((i + 1) * ARTICLES_PER_ZIP, allArticleIds.length);
      
      parts.push({
        part: i + 1,
        totalParts,
        articleCount: end - start,
        startIndex: start,
        endIndex: end - 1,
        downloadUrl: `/api/session/zip-part?session=${sessionId}&part=${i + 1}`,
        filename: `pocket-export-${sessionId}-part${i + 1}of${totalParts}.zip`
      });
    }

    return NextResponse.json({
      sessionId,
      totalArticles: allArticleIds.length,
      articlesPerZip: ARTICLES_PER_ZIP,
      totalParts,
      parts
    });

  } catch (error) {
    console.error('Get ZIP parts error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}