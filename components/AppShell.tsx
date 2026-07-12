"use client";

import { usePathname } from "next/navigation";
import AppSidebar from "@/components/AppSidebar";
import MusicWaveHeader from "@/components/MusicWaveHeader";
import SongInfoSidebar from "@/components/SongInfoSidebar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSimplePage = pathname.startsWith("/login") || pathname.startsWith("/mobile");

  return (
    <>
      {!isSimplePage && <AppSidebar />}
      <MusicWaveHeader simple={isSimplePage} />
      {!isSimplePage && <SongInfoSidebar />}
      <main className={`app-main app-main--with-wave ${isSimplePage ? "app-main--simple" : "app-main--with-sidebar"}`}>
        {children}
      </main>
    </>
  );
}
