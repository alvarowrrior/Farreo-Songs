import "./globals.scss";
import Header from "../components/header";
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
        <link rel="icon" href="/icon-192.png" />
      </head>
      <body className={`app-body ${inter.className}`}>
        <MusicPlayerProvider>
          <Header />

          <main className="app-main">{children}</main>

          <footer className="footer">
            <div className="footer__container">
              <span>Farreo © 2026</span>
              <span>Todos los derechos reservados.</span>
            </div>
          </footer>
        </MusicPlayerProvider>
      </body>
    </html>
  );
}
