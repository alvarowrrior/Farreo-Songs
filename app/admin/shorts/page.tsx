"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import AdminShorts from "@/components/AdminShorts";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export default function AdminShortsPage() {
  const [isChecking, setIsChecking] = useState(Boolean(auth));
  const [isAuthorized, setIsAuthorized] = useState(false);

  useEffect(() => {
    if (!auth) {
      setIsChecking(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const email = user?.email?.trim().toLowerCase() || "";
      setIsAuthorized(Boolean(email && ADMIN_EMAILS.includes(email)));
      setIsChecking(false);
    });
    return () => unsubscribe();
  }, []);

  if (isChecking) {
    return <div className="lyrics-editor__gate">Preparando Admin Shorts...</div>;
  }

  if (!isAuthorized) {
    return (
      <div className="lyrics-editor__gate">
        <p>Acceso restringido. Necesitas una cuenta de administrador.</p>
        <Link href="/admin" className="lyrics-editor__back">Volver</Link>
      </div>
    );
  }

  return <AdminShorts />;
}
