"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, updateProfile, type User } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function EditProfilePage() {
  const router = useRouter();
  const nameId = useId();

  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!auth) {
      router.push("/");
      return;
    }

    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) {
        router.push("/");
        return;
      }
      setUser(u);
      setDisplayName(u.displayName ?? "");
      setLoading(false);
    });

    return () => unsub();
  }, [router]);

  async function handleUpdate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);

    const current = auth?.currentUser;
    if (!current) return;

    const nextName = displayName.trim();

    // Evita llamadas inútiles
    if (nextName === (current.displayName ?? "")) {
      setMessage({ type: "success", text: "No hay cambios que guardar." });
      return;
    }

    setUpdating(true);
    try {
      await updateProfile(current, { displayName: nextName });

      // Refrescamos el estado de React para que la UI responda al instante.
      setUser({ ...current });

      setMessage({ type: "success", text: "Perfil actualizado." });

      // Opcional: si tu header depende de server components/caché
      // router.refresh();

      window.setTimeout(() => setMessage(null), 2500);
    } catch (err) {
      console.error(err);
      setMessage({ type: "error", text: "No se pudo actualizar el perfil. Inténtalo de nuevo." });
    } finally {
      setUpdating(false);
    }
  }

  async function handleSignOut() {
    try {
      await auth?.signOut();
      router.push("/");
    } catch (err) {
      console.error(err);
      setMessage({ type: "error", text: "No se pudo cerrar sesión." });
    }
  }

  if (loading) {
    return (
      <main className="profile-page profile-page--loading">
        <p className="profile-page__subtitle">Cargando…</p>
      </main>
    );
  }

  return (
    <main className="profile-page">
      <header className="profile-page__header">
        <Link href="/" className="profile-page__back-link">
          ← Volver
        </Link>
      </header>

      <section>
        <h1 className="profile-page__title">Mi perfil</h1>
        <p className="profile-page__subtitle">
          Actualiza tu nombre visible.
        </p>

        <div className="profile-page__card">
          <div className="profile-page__user-info">
            {user?.photoURL ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.photoURL}
                alt="Foto de perfil"
                className="profile-page__avatar"
              />
            ) : (
              <div className="profile-page__avatar">
                {(displayName?.[0] ?? "F").toUpperCase()}
              </div>
            )}

            <div className="profile-page__details">
              <p className="profile-page__name">
                {displayName || "Usuario de Farreo"}
              </p>
              <p className="profile-page__email">{user?.email ?? ""}</p>
            </div>
          </div>

          <form onSubmit={handleUpdate} className="profile-page__form">
            <fieldset>
              <legend className="profile-page__form-legend">
                Datos visibles
              </legend>

              <div className="profile-page__form-group">
                <label htmlFor={nameId} className="profile-page__label">
                  Nombre
                </label>
                <input
                  id={nameId}
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                  className="profile-page__input"
                  placeholder="Tu nombre…"
                />
              </div>

              {message && (
                <p
                  role={message.type === "success" ? "status" : "alert"}
                  className={`profile-page__message profile-page__message--${message.type}`}
                >
                  {message.text}
                </p>
              )}

              <button
                type="submit"
                disabled={updating}
                className="profile-page__btn-submit"
              >
                {updating ? "Guardando…" : "Guardar cambios"}
              </button>
            </fieldset>
          </form>
        </div>

        <button
          type="button"
          onClick={handleSignOut}
          className="profile-page__btn-signout"
        >
          Cerrar sesión
        </button>
      </section>
    </main>
  );
}
