"use client";

import { usePathname } from "next/navigation";
import AppSidebar from "@/components/AppSidebar";
import BackendAuthBridge from "@/components/BackendAuthBridge";
import MobileThemeSearchEnhancer from "@/components/MobileThemeSearchEnhancer";
import MusicWaveHeader from "@/components/MusicWaveHeader";
import SongInfoSidebar from "@/components/SongInfoSidebar";
import ThemeDiscoverySidebarEnhancer from "@/components/ThemeDiscoverySidebarEnhancer";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isMobilePage = pathname.startsWith("/mobile");
  const isSimplePage = pathname.startsWith("/login") || isMobilePage;

  return (
    <>
      <BackendAuthBridge />
      {!isSimplePage && <AppSidebar />}
      {!isSimplePage && <ThemeDiscoverySidebarEnhancer />}
      {isMobilePage && <MobileThemeSearchEnhancer />}
      <MusicWaveHeader simple={isSimplePage} />
      {!isSimplePage && <SongInfoSidebar />}
      <main className={`app-main app-main--with-wave ${isSimplePage ? "app-main--simple" : "app-main--with-sidebar"}`}>
        {children}
      </main>
    </>
  );
}
