"use client";

import { usePathname } from "next/navigation";
import AppSidebar from "@/components/AppSidebar";
import BackendAuthBridge from "@/components/BackendAuthBridge";
import DesktopDiscVisualController from "@/components/DesktopDiscVisualController";
import DesktopRadioClientLayer from "@/components/DesktopRadioClientLayer";
import DesktopSongRadioContextEnhancer from "@/components/DesktopSongRadioContextEnhancer";
import MobileCurrentTrackClickFix from "@/components/MobileCurrentTrackClickFix";
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
      {!isSimplePage && <DesktopSongRadioContextEnhancer />}
      {!isSimplePage && <DesktopRadioClientLayer />}
      {!isSimplePage && <DesktopDiscVisualController />}
      {isMobilePage && <MobileCurrentTrackClickFix />}
      {isMobilePage && <MobileThemeSearchEnhancer />}
      <MusicWaveHeader simple={isSimplePage} />
      {!isSimplePage && <SongInfoSidebar />}
      <main className={`app-main app-main--with-wave ${isSimplePage ? "app-main--simple" : "app-main--with-sidebar"}`}>
        {children}
      </main>
    </>
  );
}
