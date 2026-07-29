import type { NextConfig } from "next";

// Static export: one `out/` bundle serves desktop web, mobile web, and the
// Capacitor WebView. No SSR — every page is a client component and all data
// is client-side Firebase; the AI/OCR surface lives in Cloud Functions callables.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
