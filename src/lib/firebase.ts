import { initializeApp, getApps } from "firebase/app";
import { 
  getAuth, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  User as FirebaseUser
} from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  addDoc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  enableNetwork,
  disableNetwork
} from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCLg0p0sCc7PoDVAW4n_4UbqMVIdz-ocFY",
  authDomain: "cashflow-forecast-prod.firebaseapp.com",
  projectId: "cashflow-forecast-prod",
  storageBucket: "cashflow-forecast-prod.firebasestorage.app",
  messagingSenderId: "782242267594",
  appId: "1:782242267594:web:84bcfe35b2297205018f33",
  measurementId: "G-51LMB3SQ6M"
};

// Initialize Firebase (prevent re-initialization in development)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);

// Database name - using named database "cashflow-forecast"
const DATABASE_NAME = 'cashflow-forecast';

// Initialize Firestore with offline persistence
// Connecting to named database "cashflow-forecast"
let db: ReturnType<typeof initializeFirestore>;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  }, DATABASE_NAME);
  console.log('✅ [Firebase] Connected to Firestore database:', DATABASE_NAME);
} catch (error) {
  // Firestore might already be initialized
  const { getFirestore } = require("firebase/firestore");
  db = getFirestore(app, DATABASE_NAME);
  console.log('✅ [Firebase] Using existing Firestore connection:', DATABASE_NAME);
}

// Google Auth Provider
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

// Auth exports
export { 
  auth, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
  googleProvider,
  signInWithPopup
};

// Firestore exports
export {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  addDoc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  enableNetwork,
  disableNetwork
};

export type { FirebaseUser };
