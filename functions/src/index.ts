import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { aiDecision } from './ai';
export { aiChat } from './chat';
export { parseReceipt } from './receipt';
