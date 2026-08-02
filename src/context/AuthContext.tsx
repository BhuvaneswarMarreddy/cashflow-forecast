'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User } from '@/types';
import {
  auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
  googleProvider,
  signInWithPopup,
  FirebaseUser,
} from '@/lib/firebase';
import * as firestoreService from '@/lib/firestore';

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signup: (name: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signInWithGoogle: () => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  updateUserProfile: (name: string) => Promise<{ success: boolean; error?: string }>;
}

// Exported so a development-only fixture route can supply sanitized values without
// touching authentication itself (see src/app/dev/accounts-fixture/).
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Helper to convert Firebase User to our User type
const firebaseUserToUser = (firebaseUser: FirebaseUser): User => ({
  id: firebaseUser.uid,
  email: firebaseUser.email || '',
  name: firebaseUser.displayName || 'User',
  createdAt: firebaseUser.metadata.creationTime || new Date().toISOString(),
});

// Helper to get user-friendly error messages from Firebase errors
const getErrorMessage = (errorCode: string): string => {
  switch (errorCode) {
    case 'auth/email-already-in-use':
      return 'An account with this email already exists';
    case 'auth/invalid-email':
      return 'Invalid email address';
    case 'auth/operation-not-allowed':
      return 'Email/password accounts are not enabled';
    case 'auth/weak-password':
      return 'Password is too weak. Please use at least 6 characters';
    case 'auth/user-disabled':
      return 'This account has been disabled';
    case 'auth/user-not-found':
      return 'No account found with this email';
    case 'auth/wrong-password':
      return 'Incorrect password';
    case 'auth/invalid-credential':
      return 'Invalid email or password';
    case 'auth/too-many-requests':
      return 'Too many failed attempts. Please try again later';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection';
    default:
      return 'An error occurred. Please try again';
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Listen for auth state changes
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Set user immediately from Firebase Auth
        setUser(firebaseUserToUser(firebaseUser));
        setIsLoading(false);
        
        // Try to get extended user profile from Firestore (non-blocking)
        try {
          const firestoreUser = await firestoreService.getUserProfile(firebaseUser.uid);
          if (firestoreUser) {
            setUser({
              id: firestoreUser.uid,
              email: firestoreUser.email,
              name: firestoreUser.displayName,
              createdAt: firestoreUser.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
            });
          }
        } catch (error) {
          // Firestore not available - that's okay
          console.warn('Firestore profile sync skipped:', error);
        }
      } else {
        setUser(null);
        setIsLoading(false);
      }
    });

    // Cleanup subscription
    return () => unsubscribe();
  }, []);

  const login = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const firebaseUser = userCredential.user;
      
      // Set user immediately from Firebase Auth
      setUser(firebaseUserToUser(firebaseUser));
      
      // Try to sync with Firestore in the background (non-blocking)
      try {
        const firestoreUser = await firestoreService.getUserProfile(firebaseUser.uid);
        if (firestoreUser) {
          setUser({
            id: firestoreUser.uid,
            email: firestoreUser.email,
            name: firestoreUser.displayName,
            createdAt: firestoreUser.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
          });
          // Update last login time
          await firestoreService.updateLastLogin(firebaseUser.uid);
        } else {
          // If no Firestore profile exists, create one
          await firestoreService.createUserProfile(firebaseUser.uid, {
            email: firebaseUser.email || '',
            displayName: firebaseUser.displayName || 'User',
            signUpMethod: 'email',
          });
        }
      } catch (firestoreError) {
        // Firestore not available - that's okay
        console.warn('Firestore sync skipped during login:', firestoreError);
      }
      
      return { success: true };
    } catch (error: any) {
      console.error('Login error:', error);
      return { 
        success: false, 
        error: getErrorMessage(error.code) 
      };
    }
  };

  const signup = async (name: string, email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    console.log('🚀 [Signup] Starting signup process...', { name, email });
    
    try {
      console.log('📝 [Signup] Creating Firebase Auth user...');
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const firebaseUser = userCredential.user;
      console.log('✅ [Signup] Firebase Auth user created:', firebaseUser.uid);
      
      // Update the user's display name in Firebase Auth
      console.log('📝 [Signup] Updating display name...');
      await updateProfile(firebaseUser, {
        displayName: name,
      });
      console.log('✅ [Signup] Display name updated');
      
      // Create user profile in Firestore
      console.log('📝 [Signup] Creating Firestore profile...');
      try {
        await firestoreService.createUserProfile(firebaseUser.uid, {
          email: firebaseUser.email || email,
          displayName: name,
          signUpMethod: 'email',
        });
        console.log('✅ [Signup] Firestore profile created successfully');
      } catch (firestoreError: any) {
        console.error('❌ [Signup] Firestore profile creation failed:', firestoreError);
        console.error('   Error code:', firestoreError.code);
        console.error('   Error message:', firestoreError.message);
        // Don't fail signup if Firestore fails - user is already created in Auth
      }
      
      setUser({
        id: firebaseUser.uid,
        email: firebaseUser.email || email,
        name: name,
        createdAt: new Date().toISOString(),
      });
      
      console.log('🎉 [Signup] Signup completed successfully!');
      return { success: true };
    } catch (error: any) {
      console.error('❌ [Signup] Signup failed:', error);
      console.error('   Error code:', error.code);
      console.error('   Error message:', error.message);
      return { 
        success: false, 
        error: getErrorMessage(error.code) 
      };
    }
  };

  const signInWithGoogle = async (): Promise<{ success: boolean; error?: string }> => {
    console.log('🚀 [Google Sign-In] Starting Google sign-in...');
    
    try {
      console.log('📝 [Google Sign-In] Opening popup...');
      const result = await signInWithPopup(auth, googleProvider);
      const firebaseUser = result.user;
      console.log('✅ [Google Sign-In] Popup successful, user:', firebaseUser.uid);
      
      // Set user from Firebase Auth first (immediate)
      const userData: User = {
        id: firebaseUser.uid,
        email: firebaseUser.email || '',
        name: firebaseUser.displayName || 'User',
        createdAt: firebaseUser.metadata.creationTime || new Date().toISOString(),
      };
      setUser(userData);
      console.log('✅ [Google Sign-In] User state updated');
      
      // Try to sync with Firestore in the background (non-blocking)
      console.log('📝 [Google Sign-In] Checking Firestore for existing profile...');
      try {
        const existingProfile = await firestoreService.getUserProfile(firebaseUser.uid);
        
        if (existingProfile) {
          console.log('✅ [Google Sign-In] Existing profile found, updating state...');
          // User exists, update local state with Firestore data
          setUser({
            id: existingProfile.uid,
            email: existingProfile.email,
            name: existingProfile.displayName,
            createdAt: existingProfile.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
          });
          // Update last login time
          await firestoreService.updateLastLogin(firebaseUser.uid);
          console.log('✅ [Google Sign-In] Last login updated');
        } else {
          console.log('📝 [Google Sign-In] New user, creating Firestore profile...');
          // New user, create profile in Firestore
          await firestoreService.createUserProfile(firebaseUser.uid, {
            email: firebaseUser.email || '',
            displayName: firebaseUser.displayName || 'User',
            photoURL: firebaseUser.photoURL || undefined,
            signUpMethod: 'google',
          });
          console.log('✅ [Google Sign-In] Firestore profile created');
        }
      } catch (firestoreError: any) {
        // Firestore not available - that's okay, we already have user from Auth
        console.error('❌ [Google Sign-In] Firestore sync failed:', firestoreError);
        console.error('   Error code:', firestoreError.code);
        console.error('   Error message:', firestoreError.message);
      }
      
      console.log('🎉 [Google Sign-In] Sign-in completed successfully!');
      return { success: true };
    } catch (error: any) {
      console.error('❌ [Google Sign-In] Sign-in failed:', error);
      console.error('   Error code:', error.code);
      console.error('   Error message:', error.message);
      
      // Handle specific Google sign-in errors
      if (error.code === 'auth/popup-closed-by-user') {
        return { success: false, error: 'Sign-in was cancelled' };
      }
      if (error.code === 'auth/popup-blocked') {
        return { success: false, error: 'Popup was blocked. Please allow popups for this site' };
      }
      
      return { 
        success: false, 
        error: getErrorMessage(error.code) 
      };
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setUser(null);
      // Clear local storage on logout
      if (typeof window !== 'undefined') {
        Object.keys(localStorage).forEach((key) => {
          if (key.startsWith('cashflow_')) {
            localStorage.removeItem(key);
          }
        });
      }
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const resetPassword = async (email: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await sendPasswordResetEmail(auth, email);
      return { success: true };
    } catch (error: any) {
      console.error('Reset password error:', error);
      return { 
        success: false, 
        error: getErrorMessage(error.code) 
      };
    }
  };

  const updateUserProfileHandler = async (name: string): Promise<{ success: boolean; error?: string }> => {
    if (!user) {
      return { success: false, error: 'No user logged in' };
    }
    
    try {
      // Update Firebase Auth display name
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, {
          displayName: name,
        });
      }
      
      // Update Firestore profile
      try {
        await firestoreService.updateUserProfile(user.id, {
          displayName: name,
        } as any);
      } catch (firestoreError) {
        console.warn('Firestore profile update skipped:', firestoreError);
      }
      
      // Update local state
      setUser((prev) => prev ? { ...prev, name } : null);
      
      return { success: true };
    } catch (error: any) {
      console.error('Update profile error:', error);
      return { 
        success: false, 
        error: 'Failed to update profile' 
      };
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        signup,
        signInWithGoogle,
        logout,
        resetPassword,
        updateUserProfile: updateUserProfileHandler,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
