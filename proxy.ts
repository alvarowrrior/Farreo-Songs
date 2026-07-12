import { NextRequest, NextResponse } from "next/server";

const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const userAgent = request.headers.get("user-agent") || "";

  if (!MOBILE_USER_AGENT.test(userAgent) || pathname === "/mobile") {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/mobile";

  if (pathname.startsWith("/playlist/")) {
    url.searchParams.set("playlist", decodeURIComponent(pathname.slice("/playlist/".length)));
    url.searchParams.set("kind", "global");
  } else if (pathname.startsWith("/user-playlist/")) {
    url.searchParams.set("playlist", decodeURIComponent(pathname.slice("/user-playlist/".length)));
    url.searchParams.set("kind", "private");
  } else if (pathname === "/radio") {
    url.searchParams.set("tab", "radio");
  } else if (pathname === "/login" || pathname === "/perfil") {
    url.searchParams.set("tab", "account");
  }

  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next|api|brand|song-icons|advanced-covers|favicon.ico|manifest.json|.*\\..*).*)"],
};
