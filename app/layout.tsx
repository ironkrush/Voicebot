import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Talk to Krushil",
  description: "An AI voice version of Krushil Patel that answers questions about his background and work.",
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1120" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-slate-50 text-slate-900 antialiased dark:bg-[#0b1120] dark:text-slate-100">
        {children}
      </body>
    </html>
  );
}
