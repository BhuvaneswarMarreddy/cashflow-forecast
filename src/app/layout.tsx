import type { Metadata, Viewport } from "next";
import { Outfit, Space_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted at build time — no network fetch at runtime (offline/Capacitor requirement).
const outfit = Outfit({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-outfit",
  display: "swap",
});
const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});
import { AuthProvider } from "@/context/AuthContext";
import { TransactionProvider } from "@/context/TransactionContext";
import { UserProfileProvider } from "@/context/UserProfileContext";
import ClientLayout from "@/components/ClientLayout";

export const metadata: Metadata = {
  title: "CashFlow Forecast - Personal Finance Management",
  description: "Track your expenses, forecast cash flow, manage budgets, and plan for financial goals. Supports US and Indian currencies.",
  icons: {
    icon: [
      { url: "/favicons/favicon-16x16.png?v=3", sizes: "16x16", type: "image/png" },
      { url: "/favicons/favicon-32x32.png?v=3", sizes: "32x32", type: "image/png" },
      { url: "/favicons/favicon-48x48.png?v=3", sizes: "48x48", type: "image/png" },
      { url: "/favicons/favicon-64x64.png?v=3", sizes: "64x64", type: "image/png" },
    ],
    apple: [
      { url: "/logos/icon-512x512.png?v=3", sizes: "512x512", type: "image/png" },
    ],
  },
  manifest: "/manifest.json",
};

// Keystone for the whole mobile layer: viewport-fit=cover activates every env(safe-area-*)
// rule (dead until now), themeColor paints the browser chrome, and keeping zoom enabled
// (no maximumScale/userScalable) preserves pinch-to-zoom for low-vision users.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#14161a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${outfit.variable} ${spaceMono.variable}`}>
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
