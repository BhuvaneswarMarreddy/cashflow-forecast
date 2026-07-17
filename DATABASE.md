# CashFlow Forecast - Database Structure

## Overview

This document describes the Firestore database structure used by CashFlow Forecast. The database is designed for:
- **User isolation**: Each user can only access their own data
- **Scalability**: Subcollections for related data
- **Security**: Strict security rules for production deployment

---

## Database Schema

```
firestore-root/
├── users/                          # User profiles collection
│   └── {userId}/                   # Individual user document
│       ├── email: string
│       ├── displayName: string
│       ├── photoURL?: string
│       ├── createdAt: timestamp
│       ├── updatedAt: timestamp
│       ├── settings/               # Embedded object
│       │   ├── currency: string
│       │   ├── timezone: string
│       │   ├── monthlyBudget: number
│       │   └── notifications: boolean
│       ├── metadata/               # Embedded object
│       │   ├── isOnboarded: boolean
│       │   ├── lastLoginAt: timestamp
│       │   └── signUpMethod: 'email' | 'google'
│       │
│       ├── accounts/               # Subcollection: Payment accounts
│       │   └── {accountId}/
│       │       ├── name: string
│       │       ├── type: 'credit_card' | 'debit_card' | 'bank_account' | 'cash'
│       │       ├── provider: string
│       │       ├── balance: number
│       │       ├── creditLimit?: number
│       │       ├── statementDate?: number (1-31)
│       │       ├── dueDate?: number (1-31)
│       │       ├── lastFourDigits?: string
│       │       ├── color: string
│       │       ├── isActive: boolean
│       │       ├── createdAt: timestamp
│       │       └── updatedAt: timestamp
│       │
│       ├── income/                 # Subcollection: Income sources
│       │   └── {incomeId}/
│       │       ├── name: string
│       │       ├── amount: number
│       │       ├── frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly'
│       │       ├── payDate?: number (1-31)
│       │       ├── nextPayDate?: timestamp
│       │       ├── isActive: boolean
│       │       ├── createdAt: timestamp
│       │       └── updatedAt: timestamp
│       │
│       ├── transactions/           # Subcollection: All transactions
│       │   └── {transactionId}/
│       │       ├── title: string
│       │       ├── amount: number
│       │       ├── type: 'expense' | 'income'
│       │       ├── category: ExpenseCategory
│       │       ├── paymentMethod: string
│       │       ├── accountId?: string
│       │       ├── date: timestamp
│       │       ├── description?: string
│       │       ├── isRecurring?: boolean
│       │       ├── recurringFrequency?: string
│       │       ├── isProjected?: boolean
│       │       ├── createdAt: timestamp
│       │       └── updatedAt: timestamp
│       │
│       └── budgets/                # Subcollection: Category budgets (future)
│           └── {budgetId}/
│               ├── category: ExpenseCategory
│               ├── amount: number
│               ├── period: 'weekly' | 'monthly' | 'yearly'
│               └── ...
```

---

## Security Rules

The security rules ensure:
1. Users can only read/write their own data
2. All operations require authentication
3. Data validation on write operations

### Deploy Security Rules

Copy the contents of `firestore.rules` to your Firebase Console:

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project: `cashflow-forecast-prod`
3. Navigate to **Firestore Database** → **Rules**
4. Replace existing rules with contents from `firestore.rules`
5. Click **Publish**

---

## Collection Details

### Users Collection (`users/{userId}`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| uid | string | Yes | Firebase Auth UID |
| email | string | Yes | User's email |
| displayName | string | Yes | Display name |
| photoURL | string | No | Profile photo URL |
| createdAt | timestamp | Yes | Account creation time |
| updatedAt | timestamp | Yes | Last update time |
| settings | object | Yes | User preferences |
| metadata | object | Yes | App metadata |

### Accounts Subcollection (`users/{userId}/accounts/{accountId}`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Account name (e.g., "Chase Sapphire") |
| type | string | Yes | Account type |
| provider | string | Yes | Card provider (chase, amex, etc.) |
| balance | number | Yes | Current balance |
| creditLimit | number | No | Credit limit (credit cards only) |
| statementDate | number | No | Day of month for statement |
| dueDate | number | No | Day of month for payment due |
| lastFourDigits | string | No | Last 4 digits of card |
| color | string | Yes | Display color |
| isActive | boolean | Yes | Whether account is active |

### Income Subcollection (`users/{userId}/income/{incomeId}`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Income source name |
| amount | number | Yes | Amount per period |
| frequency | string | Yes | Payment frequency |
| payDate | number | No | Day of month for payment |
| nextPayDate | timestamp | No | Next expected payment |
| isActive | boolean | Yes | Whether source is active |

### Transactions Subcollection (`users/{userId}/transactions/{transactionId}`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | Transaction title |
| amount | number | Yes | Transaction amount |
| type | string | Yes | 'expense' or 'income' |
| category | string | Yes | Expense category |
| paymentMethod | string | Yes | Payment method used |
| accountId | string | No | Reference to account |
| date | timestamp | Yes | Transaction date |
| description | string | No | Additional notes |
| isRecurring | boolean | No | Is recurring transaction |
| isProjected | boolean | No | Is future/projected |

---

## Indexes

For optimal query performance, create these composite indexes in Firebase Console:

### Transactions Collection
1. `date` (Descending), `type` (Ascending)
2. `category` (Ascending), `date` (Descending)
3. `paymentMethod` (Ascending), `date` (Descending)

### How to Create Indexes
1. Go to Firebase Console → Firestore → Indexes
2. Click "Add Index"
3. Select collection path (e.g., `users/{userId}/transactions`)
4. Add the fields listed above

---

## Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   React App     │────▶│  Context Layer   │────▶│   Firestore     │
│  (Components)   │     │ (Auth, Profile,  │     │   (Database)    │
│                 │◀────│  Transactions)   │◀────│                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │                       │
        │                       ▼
        │               ┌──────────────────┐
        └──────────────▶│  localStorage    │
                        │   (Fallback)     │
                        └──────────────────┘
```

---

## Offline Support

The app includes localStorage fallback for offline operation:

1. **Read**: Try Firestore first, fallback to localStorage
2. **Write**: Write to localStorage immediately, sync to Firestore when online
3. **Sync**: On reconnection, data is synced back to Firestore

---

## Environment Variables

For production deployment, set these environment variables:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=your-api-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
NEXT_PUBLIC_FIREBASE_APP_ID=your-app-id
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=your-measurement-id
```

---

## Backup & Recovery

### Export Data
```bash
gcloud firestore export gs://your-bucket/backups/$(date +%Y%m%d)
```

### Import Data
```bash
gcloud firestore import gs://your-bucket/backups/20241227
```

---

## Production Checklist

- [ ] Deploy Firestore security rules from `firestore.rules`
- [ ] Create required composite indexes
- [ ] Set up environment variables
- [ ] Enable Firebase Authentication (Email/Password + Google)
- [ ] Configure Firebase Hosting (optional)
- [ ] Set up backup schedule
- [ ] Enable Firebase Analytics (optional)
- [ ] Configure rate limiting / usage alerts

