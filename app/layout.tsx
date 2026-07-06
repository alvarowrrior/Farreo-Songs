import "./globals.scss";
import AppShell from "@/components/AppShell";
import MusicPlayerProvider from "@/components/MusicPlayerProvider";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#000000" />
        <link rel="icon" type="image/png" href="/brand/farreo-f.png" />
        <link rel="shortcut icon" href="/brand/farreo-f.png" />
        <link rel="apple-touch-icon" href="/brand/farreo-f.png" />
      </head>
      <body className={`app-body ${inter.className}`}>
        <MusicPlayerProvider>
          <AppShell>{children}</AppShell>
        </MusicPlayerProvider>
      </body>
    </html>
  );
}
