import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { QueryProvider } from "@/providers/QueryProvider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-sf",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Observatory — Agent Workspace",
  description: "Multi-agent collaboration workspace",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={cn("font-sans", inter.variable, jetbrainsMono.variable)}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background text-foreground">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
