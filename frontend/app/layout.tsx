import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Maya AI — Local-first assistant",
  description: "A private AI workspace powered by your local Maya backend.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
