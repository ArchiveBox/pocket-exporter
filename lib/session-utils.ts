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