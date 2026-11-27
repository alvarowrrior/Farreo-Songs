import type { CapacitorConfig } from "@capacitor/cli";

const mobileUrl =
  process.env.CAPACITOR_SERVER_URL ||
  process.env.FARREO_ANDROID_URL ||
  "https://farreo.vercel.app/mobile";

const config: CapacitorConfig = {
  appId: "com.farreo.app",
  appName: "Farreo",
  webDir: "public",
  server: {
    url: mobileUrl,
    cleartext: mobileUrl.startsWith("http://"),
    // Sin red y sin service worker: pagina de musica descargada incluida en la APK.
    errorPath: "offline-app.html",
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
