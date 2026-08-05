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
  deleteUser,
  EmailAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
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
  apiKey: "AIzaSyAUv5SbN1OF4ugO1mICBtEzBzPRlb4F00k",
  // Custom domain: popup shows the brand, and same-origin auth sidesteps
  // Safari/iOS third-party-cookie blocking. The /__/auth/* handler is served
  // by Firebase Hosting on this domain (verified 200).
  authDomain: "cashflowforcast.com",
  projectId: "marreddy-cashflow",
  storageBucket: "marreddy-cashflow.firebasestorage.app",
  messagingSenderId: "958007946272",
  appId: "1:958007946272:web:69ad68f15965e63af3e045"
};

// Initialize Firebase (prevent re-initialization in development)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);

// Initialize Firestore with offline persistence on the (default) database — the same
// database firestore.rules is deployed to, so rules and reads/writes stay in sync.
let db: ReturnType<typeof initializeFirestore>;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
  console.log('✅ [Firebase] Connected to Firestore (default database)');
} catch (error) {
  // Firestore might already be initialized
  const { getFirestore } = require("firebase/firestore");
  db = getFirestore(app);
  console.log('✅ [Firebase] Using existing Firestore connection');
}

// Google Auth Provider
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

// Auth exports
export {
  app,
  auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
  googleProvider,
  signInWithPopup,
  deleteUser,
  EmailAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup
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
