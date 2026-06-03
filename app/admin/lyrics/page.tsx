"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import LyricsEditor from "@/components/LyricsEditor";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",");

export default function AdminLyricsPage() {
  const [isChecking, setIsChecking] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);

  useEffect(() => {
    if (!auth) {
      setIsAuthorized(false);
      setIsChecking(false);
      return;
    }
    const unsub = onAuthStateChanged(auth, (user) => {
      setIsAuthorized(Boolean(user?.email && ADMIN_EMAILS.includes(user.email)));
      setIsChecking(false);
    });
    return () => unsub();
  }, []);

  if (isChecking) {
    return <div className="lyrics-editor__gate">Comprobando acceso...</div>;
  }

  if (!isAuthorized) {
    return (
      <div className="lyrics-editor__gate">
        <p>Acceso restringido. Necesitas una cuenta de administrador.</p>
        <Link href="/admin" className="lyrics-editor__back">
          Volver
        </Link>
      </div>
    );
  }

  return <LyricsEditor />;
}
