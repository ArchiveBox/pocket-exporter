import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import { getDownloadStatus } from '@/lib/article-downloader';
import { getSessionSizeInMB, readPaymentData, updatePaymentData, fetchCompletePaymentDetails } from '@/lib/session-utils';
import { stripe } from '@/lib/stripe';
import { execSync } from 'child_process';
import { withTiming } from '@/lib/with-timing';
import { getRateLimitStatus, loadRateLimitState } from '@/lib/rate-limiter';
import type { Article } from '@/types/article';

// Minimal article type for status response to reduce payload size
interface MinimalArticle {
  title: string;
  url: string;
  savedId: string;
  tags: Array<{ id: string; name: string }>;
  _createdAt: number;
  item?: {
    readerSlug?: string;
    domainMetadata?: {
      name?: string;
    };
    hasVideo?: string;
    givenUrl?: string;
  };
  archivedotorg_url?: string;
  fallbackImageUrls?: string[];
}

// Function to convert full Article to MinimalArticle
function toMinimalArticle(article: Article): MinimalArticle {
  return {
    title: article.title,
    url: article.url,
    savedId: article.savedId,
    tags: article.tags.map(tag => ({ id: tag.id, name: tag.name })),
    _createdAt: article._createdAt,
    item: article.item ? {
      readerSlug: article.item.readerSlug,
      domainMetadata: article.item.domainMetadata ? {
        name: article.item.domainMetadata.name
      } : undefined,
      hasVideo: article.item.hasVideo,
      givenUrl: article.item.givenUrl
    } : undefined,
    archivedotorg_url: article.archivedotorg_url,
    fallbackImageUrls: article.fallbackImageUrls
  };
}

export const GET = withTiming(async (request: NextRequest) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');
    const lastFetchedCount = searchParams.get('lastFetchedCount');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    let session = await exportStore.getSession(sessionId);

    if (!session) {
      // Check if this is an old consumer key format
      const isOldFormat = sessionId.match(/^[\w\d]{5}-[\w-]+$/);
      
      if (!isOldFormat) {
        console.log('Session not found:', sessionId);
      }
      
      // For old format sessions, return a response that triggers re-authentication
      if (isOldFormat) {
        // Return a session with an authentication error - this should make the old
        // frontend show the auth form and stop polling
        return NextResponse.json({
          id: sessionId,
          auth: null, // No auth means not authenticated
          currentFetchTask: {
            status: 'error',
            error: 'Authentication expired',
            count: 0,
            total: 0
          },
          currentDownloadTask: {
            status: 'idle',
            count: 0,
            total: 0
          },
          articles: [],
          downloadStatus: {
            total: 0,
            completed: 0,
            downloading: 0,
            errors: 0,
            articleStatus: {}
          },
          sessionSizeMB: 0,
          paymentData: null
        });
      }
      
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Always return the full list of articles from disk
    const allArticles = await exportStore.getSessionArticles(sessionId);

    // Check if download task process is actually running
    if (session.currentDownloadTask && 
        session.currentDownloadTask.status === 'running' && 
        session.currentDownloadTask.pid) {
      try {
        // Check if process exists (kill -0 just checks, doesn't actually kill)
        execSync(`kill -0 ${session.currentDownloadTask.pid}`, { stdio: 'ignore' });
      } catch (error) {
        // Process doesn't exist, update task status to stopped
        console.log(`Download process ${session.currentDownloadTask.pid} not found, updating status to stopped`);
        await exportStore.updateDownloadTask(sessionId, {
          status: 'stopped',
          endedAt: new Date(),
          currentID: undefined
        });
        // Refresh session data
        session = await exportStore.getSession(sessionId)!;
      }
    }
    
    // Check if fetch task process is actually running
    if (session.currentFetchTask && 
        session.currentFetchTask.status === 'running' && 
        session.currentFetchTask.pid) {
      try {
        execSync(`kill -0 ${session.currentFetchTask.pid}`, { stdio: 'ignore' });
      } catch (error) {
        // Process doesn't exist, update task status to stopped
        console.log(`Fetch process ${session.currentFetchTask.pid} not found, updating status to stopped`);
        await exportStore.updateFetchTask(sessionId, {
          status: 'stopped',
          endedAt: new Date(),
          currentID: undefined
        });
        // Refresh session data
        session = await exportStore.getSession(sessionId)!;
      }
    }
    
    const downloadStatus = await getDownloadStatus(sessionId, allArticles);
    const sessionSizeMB = await getSessionSizeInMB(sessionId);
    let paymentData = await readPaymentData(sessionId);
    
    // Only check and sync payment status with Stripe if payment is not already completed
    if (paymentData?.payment?.stripeSessionId && paymentData.payment.status !== 'completed') {
      console.log(`Checking payment status for session ${sessionId}, current status: ${paymentData.payment.status}`);
      try {
        const stripeSession = await stripe.checkout.sessions.retrieve(
          paymentData.payment.stripeSessionId
        );
        
        console.log(`Stripe session ${paymentData.payment.stripeSessionId} status: ${stripeSession.status}, payment_status: ${stripeSession.payment_status}, payment_intent: ${stripeSession.payment_intent}`);
        
        // Check both session status and payment status
        let isPaymentComplete = stripeSession.status === 'complete' || 
                               stripeSession.payment_status === 'paid';
        
        // Always check the payment intent if available
        if (stripeSession.payment_intent && !isPaymentComplete) {
          try {
            const paymentIntent = await stripe.paymentIntents.retrieve(stripeSession.payment_intent as string);
            console.log(`Payment intent ${paymentIntent.id} status: ${paymentIntent.status}`);
            
            if (paymentIntent.status === 'succeeded' && paymentData.payment.status !== 'completed') {
              console.log(`Payment intent succeeded, updating payment status for session ${sessionId}`);
              
              let chargeData = {};
              // Retrieve charge information
              if (paymentIntent.latest_charge) {
                try {
                  const charge = await stripe.charges.retrieve(paymentIntent.latest_charge as string);
                  chargeData = {
                    stripeChargeId: charge.id,
                    receiptUrl: charge.receipt_url,
                    receiptEmail: charge.receipt_email,
                    customerId: charge.customer as string
                  };
                  console.log(`Retrieved charge ${charge.id} for verification`);
                } catch (chargeError) {
                  console.error('Error retrieving charge:', chargeError);
                }
              }
              
              paymentData = await updatePaymentData(sessionId, {
                hasUnlimitedAccess: true,
                payment: {
                  ...paymentData.payment,
                  status: 'completed',
                  stripePaymentIntentId: paymentIntent.id,
                  amount: paymentIntent.amount || stripeSession.amount_total || 0,
                  currency: paymentIntent.currency || stripeSession.currency || 'usd',
                  completedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  ...chargeData
                }
              });
              console.log(`Payment verified via payment intent and updated for session ${sessionId}`);
            }
          } catch (piError) {
            console.error('Error checking payment intent:', piError);
          }
        } else if (isPaymentComplete && paymentData.payment.status !== 'completed') {
          console.log(`Updating payment status to completed for session ${sessionId}`);
          
          // Fetch complete payment details including charge and receipt
          const completeDetails = await fetchCompletePaymentDetails(
            stripeSession.id,
            stripeSession.payment_intent as string
          );
          
          paymentData = await updatePaymentData(sessionId, {
            hasUnlimitedAccess: true,
            payment: {
              ...paymentData.payment,
              status: 'completed',
              stripePaymentIntentId: stripeSession.payment_intent as string,
              amount: stripeSession.amount_total || 0,
              currency: stripeSession.currency || 'usd',
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              ...completeDetails // This includes receiptUrl, chargeId, etc.
            }
          });
          console.log(`Payment verified and updated for session ${sessionId} with receipt: ${paymentData.payment?.receiptUrl}`);
        }
      } catch (error) {
        console.error('Error checking Stripe payment status:', error);
      }
    }
    
    // Debug logging
    // console.log(`Status endpoint: returning ${allArticles.length} total articles for session ${sessionId}`);
    // if (downloadStatus.total > 0) {
      // console.log(`Download status for ${sessionId}: ${downloadStatus.completed}/${downloadStatus.total} completed`);
    // }
    
    // Strip sensitive auth data before sending to frontend
    const sanitizedSession = {
      ...session,
      auth: session.auth ? {
        cookieString: '✅',
        headers: '✅'
      } : undefined
    };
    
    // Load rate limit state from session first
    await loadRateLimitState(sessionId);
    
    // Get rate limit status
    const rateLimitStatus = getRateLimitStatus(sessionId);
    
    // Debug log if in slow mode
    // if (rateLimitStatus.isInSlowMode) {
    //   const now = Date.now();
    //   const nextTime = new Date(rateLimitStatus.nextRequestAvailable).getTime();
    //   const secondsUntilNext = Math.round((nextTime - now) / 1000);
    //   console.log(`Rate limit status: slow mode, next request in ${secondsUntilNext}s`);
    //   console.log(`  nextRequestAvailable: ${rateLimitStatus.nextRequestAvailable.toISOString()}`);
    //   console.log(`  now: ${new Date(now).toISOString()}`);
    //   console.log(`  difference: ${nextTime - now}ms`);
    // }
    
    // Debug logging
    // if (rateLimitStatus.requestsInLastHour > 0) {
    //   console.log(`Rate limit status for ${sessionId}:`, {
    //     requestsInLastHour: rateLimitStatus.requestsInLastHour,
    //     isInSlowMode: rateLimitStatus.isInSlowMode,
    //     nextRequestAvailable: rateLimitStatus.nextRequestAvailable
    //   });
    // }
    
    
    // Convert articles to minimal format to reduce payload size
    const minimalArticles = allArticles.map(toMinimalArticle);
    
    // Return session.json with sensitive data stripped and articles added
    return NextResponse.json({
      ...sanitizedSession,
      articles: minimalArticles,
      downloadStatus,
      sessionSizeMB,
      paymentData,
      rateLimitStatus
    });

  } catch (error) {
    console.error('Get status error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});
