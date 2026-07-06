"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, User } from "firebase/auth";
import { auth } from "../../lib/firebase";

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function LoginPage() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);

  // Mantiene el estado del usuario sincronizado (mejor que auth.currentUser directo)
  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  async function loginWithGoogle() {
    if (!auth) {
      alert("Firebase no esta configurado.");
      return;
    }

    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (e: unknown) {
      console.error(e);
      alert(getErrorMessage(e, "Error al iniciar sesión con Google"));
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    if (!auth) {
      return;
    }

    try {
      await signOut(auth);
    } catch (e: unknown) {
      console.error(e);
      alert(getErrorMessage(e, "Error al cerrar sesión"));
    }
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <Link href="/" className="login-card__back">
          ← Volver
        </Link>

        <div className="login-card__brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/farreo.png" alt="Farreo" />
        </div>

        <h1 className="login-card__title">Login</h1>
        <p className="login-card__subtitle">
          Entra con Google para acceder a la biblioteca privada de Farreo.
        </p>

        <div className="login-card__box">
          {user ? (
            <>
              <p className="login-card__subtitle">Sesión iniciada como:</p>
              <p className="login-card__title login-card__title--small">{user.displayName ?? "Usuario"}</p>
              <p className="login-card__subtitle">{user.email ?? ""}</p>

              <button
                onClick={logout}
                className="login-card__btn login-card__btn--secondary"
              >
                Cerrar sesión
              </button>
            </>
          ) : (
            <button
              onClick={loginWithGoogle}
              disabled={loading}
              className="login-card__btn login-card__btn--primary"
            >
              {loading ? "Abriendo Google..." : "Continuar con Google"}
            </button>
          )}
        </div>

        <p className="login-card__footer">
          La información de tu perfil se sincroniza con tu cuenta de Google. Puedes gestionarla desde la configuración de tu cuenta.
        </p>
      </div>
    </main>
  );
}
