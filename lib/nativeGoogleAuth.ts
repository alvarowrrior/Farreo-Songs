"use client";

export interface NativeGoogleAuthPlugin {
  signIn: (payload: { webClientId: string }) => Promise<{ idToken: string }>;
}

export function getFarreoNativeGoogleAuth(): NativeGoogleAuthPlugin | null {
  if (typeof window === "undefined") return null;
  return (window.Capacitor?.Plugins?.FarreoGoogleAuth as NativeGoogleAuthPlugin | undefined) ?? null;
}
