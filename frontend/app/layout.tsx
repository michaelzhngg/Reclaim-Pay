import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext"; // Import AuthProvider
import ServiceWorkerRegistration from "./_components/ServiceWorkerRegistration";
import PushNotificationProvider from "./_components/PushNotificationProvider";
import { ToastProvider } from "@/components/toast/ToastProvider";
import { AppearanceProvider } from "@/components/theme/AppearanceProvider";
import { THEME_BOOT_SCRIPT } from "@/lib/theme/preferences";

const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  weight: "100 900",
  variable: "--font-inter",
});

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-visual",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0f0f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f1a" },
  ],
};

const DESCRIPTION =
  "An AI agent checks each expense claim against policy, pays clean low-risk claims to the employee's PayPal in under a minute, and sends everything else to HR with the evidence. Automation where it's safe, judgment where it matters.";

export const metadata: Metadata = {
  title: "Reclaim Pay",
  description: DESCRIPTION,
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Reclaim Pay",
  },
  icons: {
    icon: "/images/logo.svg",
    apple: "/icons/apple-touch-icon.png",
  },
  openGraph: {
    title: "Reclaim Pay",
    description: DESCRIPTION,
    images: [
      {
        url: "/images/logo.svg",
        width: 800,
        height: 600,
        alt: "Reclaim Pay logo",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Reclaim Pay",
    description: DESCRIPTION,
    images: ["/images/logo.svg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // The boot script below sets data-theme and data-density before React hydrates.
      suppressHydrationWarning
      className={`${inter.variable} ${interTight.variable} ${mono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <AppearanceProvider>
          <ToastProvider>
            <AuthProvider>
              <PushNotificationProvider>
                {children}
                <ServiceWorkerRegistration />
              </PushNotificationProvider>
            </AuthProvider>
          </ToastProvider>
        </AppearanceProvider>
      </body>
    </html>
  );
}
