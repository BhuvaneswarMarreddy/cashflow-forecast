import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { TransactionProvider } from "@/context/TransactionContext";
import { UserProfileProvider } from "@/context/UserProfileContext";
import ClientLayout from "@/components/ClientLayout";

export const metadata: Metadata = {
  title: "CashFlow Forecast - Personal Finance Management",
  description: "Track your expenses, forecast cash flow, manage budgets, and plan for financial goals. Supports US and Indian currencies.",
  icons: {
    icon: [
      { url: "/favicons/favicon-16x16.png?v=2", sizes: "16x16", type: "image/png" },
      { url: "/favicons/favicon-32x32.png?v=2", sizes: "32x32", type: "image/png" },
      { url: "/favicons/favicon-48x48.png?v=2", sizes: "48x48", type: "image/png" },
      { url: "/favicons/favicon-64x64.png?v=2", sizes: "64x64", type: "image/png" },
    ],
    apple: [
      { url: "/logos/icon-512x512.png?v=2", sizes: "512x512", type: "image/png" },
    ],
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthProvider>
          <UserProfileProvider>
            <TransactionProvider>
              <ClientLayout>
                {children}
              </ClientLayout>
            </TransactionProvider>
          </UserProfileProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
