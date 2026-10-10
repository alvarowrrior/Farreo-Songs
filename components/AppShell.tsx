"use client";

import { usePathname } from "next/navigation";
import AppSidebar from "@/components/AppSidebar";
import PlaybackQueueIsland from "@/components/PlaybackQueueIsland";
import BackendAuthBridge from "@/components/BackendAuthBridge";
import DesktopDiscVisualController from "@/components/DesktopDiscVisualController";
import DesktopRadioClientLayer from "@/components/DesktopRadioClientLayer";
import DesktopSongRadioContextEnhancer from "@/components/DesktopSongRadioContextEnhancer";
import DesktopYoutubeVideoBackground from "@/components/DesktopYoutubeVideoBackground";
import DesktopYoutubeVideoToggle from "@/components/DesktopYoutubeVideoToggle";
import MobileCurrentTrackClickFix from "@/components/MobileCurrentTrackClickFix";
import MobileAppUpdateLegacyFeedback from "@/components/MobileAppUpdateLegacyFeedback";
import MobileThemeSearchEnhancer from "@/components/MobileThemeSearchEnhancer";
import MusicWaveHeader from "@/components/MusicWaveHeader";
import DesktopSongInfoSidebar from "@/components/DesktopSongInfoSidebar";
import ThemeDiscoverySidebarEnhancer from "@/components/ThemeDiscoverySidebarEnhancer";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isMobilePage = pathname.startsWith("/mobile");
  const isSimplePage = pathname.startsWith("/login") || isMobilePage;

  return (
    <>
      <BackendAuthBridge />
      {!isSimplePage && <DesktopYoutubeVideoBackground />}
      {!isSimplePage && <DesktopYoutubeVideoToggle />}
      {!isSimplePage && <AppSidebar />}
      {!isSimplePage && <PlaybackQueueIsland />}
      {!isSimplePage && <ThemeDiscoverySidebarEnhancer />}
      {!isSimplePage && <DesktopSongRadioContextEnhancer />}
      {!isSimplePage && <DesktopRadioClientLayer />}
      {!isSimplePage && <DesktopDiscVisualController />}
      {isMobilePage && <MobileCurrentTrackClickFix />}
      {isMobilePage && <MobileAppUpdateLegacyFeedback />}
      {isMobilePage && <MobileThemeSearchEnhancer />}
      <MusicWaveHeader simple={isSimplePage} />
      {!isSimplePage && <DesktopSongInfoSidebar />}
      <main className={`app-main app-main--with-wave ${isSimplePage ? "app-main--simple" : "app-main--with-sidebar"}`}>
        {children}
      </main>
    </>
  );
}
