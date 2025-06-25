import fs from 'fs';
import path from 'path';

const SESSIONS_DIR = path.join(process.cwd(), 'sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

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

export function getPaymentsPath(sessionId: string): string {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return path.join(sessionDir, 'payments.json');
}

export function readPaymentData(sessionId: string): SessionPaymentData | null {
  try {
    const paymentsPath = getPaymentsPath(sessionId);
    if (!fs.existsSync(paymentsPath)) {
      return null;
    }
    const data = fs.readFileSync(paymentsPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading payment data:', error);
    return null;
  }
}

export function writePaymentData(sessionId: string, data: SessionPaymentData): SessionPaymentData {
  try {
    const paymentsPath = getPaymentsPath(sessionId);
    console.log(`Writing payment data to ${paymentsPath}:`, JSON.stringify(data, null, 2));
    fs.writeFileSync(paymentsPath, JSON.stringify(data, null, 2));
    
    // Verify the write
    const verifyData = fs.readFileSync(paymentsPath, 'utf8');
    console.log(`Verified written data:`, verifyData);
    
    return data;
  } catch (error) {
    console.error('Error writing payment data:', error);
    throw error;
  }
}

export function updatePaymentData(sessionId: string, updates: Partial<SessionPaymentData>): SessionPaymentData {
  const existingData = readPaymentData(sessionId) || {
    articlesFetchedBeforePayment: 0,
    hasUnlimitedAccess: false
  };
  
  // Deep merge for nested payment object
  const updatedData: SessionPaymentData = {
    ...existingData,
    ...updates,
    payment: updates.payment ? {
      ...existingData.payment,
      ...updates.payment
    } : existingData.payment
  };
  
  return writePaymentData(sessionId, updatedData);
}

export function hasValidPayment(sessionId: string): boolean {
  const paymentData = readPaymentData(sessionId);
  return paymentData?.hasUnlimitedAccess === true && 
         paymentData?.payment?.status === 'completed';
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

export function canFetchMoreArticles(sessionId: string, currentArticleCount: number): boolean {
  const paymentData = readPaymentData(sessionId);
  
  // If they have unlimited access, they can fetch more
  if (paymentData?.hasUnlimitedAccess === true) {
    return true;
  }
  
  // Otherwise, check if they've hit the 100 article limit
  return currentArticleCount < 100;
}

export function recordArticlesFetched(sessionId: string, count: number): void {
  const paymentData = readPaymentData(sessionId) || {
    articlesFetchedBeforePayment: 0,
    hasUnlimitedAccess: false
  };
  
  // Only update if they don't have unlimited access
  if (!paymentData.hasUnlimitedAccess) {
    paymentData.articlesFetchedBeforePayment = count;
    writePaymentData(sessionId, paymentData);
  }
}

export function getSessionSizeInMB(sessionId: string): number {
  try {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
      return 0;
    }
    
    let totalSize = 0;
    
    function calculateDirSize(dir: string): void {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          calculateDirSize(filePath);
        } else {
          totalSize += stats.size;
        }
      }
    }
    
    calculateDirSize(sessionDir);
    return totalSize / (1024 * 1024); // Convert to MB
  } catch (error) {
    console.error('Error calculating session size:', error);
    return 0;
  }
}