"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { ShieldIcon } from "lucide-react";
import { auth } from "../lib/firebase";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",");

function Avatar({ user }: { user: User }) {
  const photo = user.photoURL;
  const name = user.displayName ?? user.email ?? "Usuario";
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

  if (photo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photo}
        alt={name}
        className="avatar__img"
        referrerPolicy="no-referrer"
      />
    );
  }

  return <div className="avatar__fallback">{initials || "U"}</div>;
}

export default function Header() {
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const isAdmin = user?.email ? ADMIN_EMAILS.includes(user.email) : false;

  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  async function logout() {
    if (!auth) return;
    await signOut(auth);
    setMenuOpen(false);
  }

  return (
    <header className="header">
      <div className="header__container">
        <Link href="/" className="header__logo">
          Farreo
        </Link>

        <nav className="header__nav">
          {isAdmin && (
            <Link
              href="/admin"
              className="header__link header__link--music"
              title="Panel de administracion"
            >
              <ShieldIcon size={18} />
              <span>Admin</span>
            </Link>
          )}

          {user ? (
            <div className="header__user">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="header__user-btn"
                aria-label="Abrir menu de usuario"
              >
                <Avatar user={user} />
                <span className="header__user-name">
                  {user.displayName ?? "Mi cuenta"}
                </span>
              </button>

              {menuOpen && (
                <ul
                  className="header__dropdown"
                  onMouseLeave={() => setMenuOpen(false)}
                  role="menu"
                >
                  <li className="header__dropdown-header" role="presentation">
                    <p className="header__dropdown-name">
                      {user.displayName ?? "Usuario"}
                    </p>
                    <p className="header__dropdown-email">{user.email ?? ""}</p>
                  </li>

                  <li role="presentation">
                    <hr className="header__dropdown-divider" />
                  </li>

                  <li role="presentation">
                    <Link
                      href="/perfil"
                      className="header__dropdown-link"
                      onClick={() => setMenuOpen(false)}
                      role="menuitem"
                    >
                      Perfil
                    </Link>
                  </li>

                  {isAdmin && (
                    <li role="presentation">
                      <Link
                        href="/admin"
                        className="header__dropdown-link"
                        onClick={() => setMenuOpen(false)}
                        role="menuitem"
                      >
                        Admin
                      </Link>
                    </li>
                  )}

                  <li role="presentation">
                    <button
                      onClick={logout}
                      className="header__dropdown-btn header__dropdown-btn--danger"
                      role="menuitem"
                    >
                      Cerrar sesion
                    </button>
                  </li>
                </ul>
              )}
            </div>
          ) : (
            <Link href="/login" className="header__link">
              Login
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
