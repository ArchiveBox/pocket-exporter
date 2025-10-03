import fs from 'fs';
import path from 'path';
import { atomicWriteJson, readJsonFile } from './atomic-write';

const SESSIONS_DIR = path.join(process.cwd(), 'sessions');

// Ensure sessions directory exists
fs.promises.mkdir(SESSIONS_DIR, { recursive: true }).catch(() => {});

export interface PaymentData {
  status: 'pending' | 'completed' | 'failed';
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  amount?: number;
  currency?: string;
  receiptUrl?: string;
  receiptEmail?: string;
  customerId?: string;
  createdAt: string;
  completedAt?: string;
  updatedAt: string;
}

export interface SessionPaymentData {
  articlesFetchedBeforePayment: number;
  hasUnlimitedAccess: boolean;
  payment?: PaymentData;
}

export async function getPaymentsPath(sessionId: string): Promise<string> {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true }).catch(() => {});
  return path.join(sessionDir, 'payments.json');
}

export async function readPaymentData(sessionId: string): Promise<SessionPaymentData | null> {
  try {
    const paymentsPath = await getPaymentsPath(sessionId);
    return await readJsonFile<SessionPaymentData>(paymentsPath);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('Error reading payment data:', error);
    }
    return null;
  }
}

export async function writePaymentData(sessionId: string, data: SessionPaymentData): Promise<SessionPaymentData> {
  try {
    const paymentsPath = await getPaymentsPath(sessionId);
    console.log(`Writing payment data to ${paymentsPath}:`, JSON.stringify(data, null, 2));
    await atomicWriteJson(paymentsPath, data);
    
    // Verify the write
    const verifyData = await readJsonFile(paymentsPath);
    console.log(`Verified written data:`, JSON.stringify(verifyData, null, 2));
    
    return data;
  } catch (error) {
    console.error('Error writing payment data:', error);
    throw error;
  }
}

export async function updatePaymentData(sessionId: string, updates: Partial<SessionPaymentData>): Promise<SessionPaymentData> {
  const paymentsPath = await getPaymentsPath(sessionId);
  
  // Use atomic merge write to handle concurrent updates
  await atomicWriteJson(paymentsPath, updates, { merge: true });
  
  // Read back the merged data
  const result = await readPaymentData(sessionId);
  return result || {
    articlesFetchedBeforePayment: 0,
    hasUnlimitedAccess: false,
    ...updates
  };
}

export async function hasValidPayment(sessionId: string): Promise<boolean> {
  // Paywall disabled - everyone has valid payment
  return true;
  
  // Original paywall code commented out:
  // const paymentData = await readPaymentData(sessionId);
  // return paymentData?.hasUnlimitedAccess === true && 
  //        paymentData?.payment?.status === 'completed';
}

// Helper function to fetch complete payment details from Stripe
export async function fetchCompletePaymentDetails(
  checkoutSessionId?: string,
  paymentIntentId?: string
): Promise<Partial<PaymentData>> {
  const { stripe } = await import('@/lib/stripe');
  let paymentDetails: Partial<PaymentData> = {};
  
  try {
    // If we have a checkout session ID, retrieve it
    if (checkoutSessionId) {
      const checkoutSession = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      paymentDetails.stripeSessionId = checkoutSession.id;
      paymentDetails.amount = checkoutSession.amount_total || 0;
      paymentDetails.currency = checkoutSession.currency || 'usd';
      
      // Get payment intent ID from checkout session if not provided
      if (!paymentIntentId && checkoutSession.payment_intent) {
        paymentIntentId = checkoutSession.payment_intent as string;
      }
    }
    
    // If we have a payment intent ID, retrieve it and the charge
    if (paymentIntentId) {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      paymentDetails.stripePaymentIntentId = paymentIntent.id;
      paymentDetails.amount = paymentIntent.amount || paymentDetails.amount;
      paymentDetails.currency = paymentIntent.currency || paymentDetails.currency;
      
      // Get charge details for receipt
      if (paymentIntent.latest_charge) {
        try {
          const charge = await stripe.charges.retrieve(paymentIntent.latest_charge as string);
          paymentDetails.stripeChargeId = charge.id;
          paymentDetails.receiptUrl = charge.receipt_url || undefined;
          paymentDetails.receiptEmail = charge.receipt_email || undefined;
          paymentDetails.customerId = charge.customer as string || undefined;
          console.log(`Retrieved charge ${charge.id} with receipt: ${charge.receipt_url}`);
        } catch (chargeError) {
          console.error('Error retrieving charge:', chargeError);
        }
      }
    }
  } catch (error) {
    console.error('Error fetching complete payment details:', error);
  }
  
  return paymentDetails;
}

export async function canFetchMoreArticles(sessionId: string, currentArticleCount: number): Promise<boolean> {
  // Paywall disabled - everyone gets unlimited access
  return true;
  
  // Original paywall code commented out:
  // const paymentData = await readPaymentData(sessionId);
  // 
  // // If they have unlimited access, they can fetch more
  // if (paymentData?.hasUnlimitedAccess === true) {
  //   return true;
  // }
  // 
  // // Otherwise, check if they've hit the 100 article limit
  // return currentArticleCount < 100;
}

export async function recordArticlesFetched(sessionId: string, count: number): Promise<void> {
  const paymentData = await readPaymentData(sessionId) || {
    articlesFetchedBeforePayment: 0,
    hasUnlimitedAccess: false
  };
  
  // Only update if they don't have unlimited access
  if (!paymentData.hasUnlimitedAccess) {
    paymentData.articlesFetchedBeforePayment = count;
    await writePaymentData(sessionId, paymentData);
  }
}

export async function getSessionSizeInMB(sessionId: string): Promise<number> {
  try {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    
    let totalSize = 0;
    
    async function calculateDirSize(dir: string): Promise<void> {
      try {
        const files = await fs.promises.readdir(dir);
        
        await Promise.all(files.map(async (file) => {
          const filePath = path.join(dir, file);
          try {
            const stats = await fs.promises.stat(filePath);
            if (stats.isDirectory()) {
              await calculateDirSize(filePath);
            } else {
              totalSize += stats.size;
            }
          } catch {
            // Ignore errors for individual files
          }
        }));
      } catch {
        // Directory doesn't exist or not accessible
      }
    }
    
    await calculateDirSize(sessionDir);
    return totalSize / (1024 * 1024); // Convert to MB
  } catch (error) {
    console.error('Error calculating session size:', error);
    return 0;
  }
}