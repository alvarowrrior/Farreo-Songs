import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

export type PrivatePlaylistVisibility = "private" | "public";

export interface PrivatePlaylist {
  id: string;
  ownerId: string;
  ownerEmail?: string | null;
  nombre: string;
  iconUrl?: string | null;
  visibility: PrivatePlaylistVisibility;
  songIds: string[];
}

const COLLECTION = "privatePlaylists";

const assertDb = () => {
  if (!db) throw new Error("Firebase no esta configurado.");
  return db;
};

const mapPrivatePlaylist = (id: string, data: Record<string, unknown>): PrivatePlaylist => ({
  id,
  ownerId: String(data.ownerId || ""),
  ownerEmail: typeof data.ownerEmail === "string" ? data.ownerEmail : null,
  nombre: String(data.nombre || "Playlist sin nombre"),
  iconUrl: typeof data.iconUrl === "string" ? data.iconUrl : null,
  visibility: data.visibility === "public" ? "public" : "private",
  songIds: Array.isArray(data.songIds) ? data.songIds.map(String) : [],
});

export async function listOwnPrivatePlaylists(ownerId: string) {
  const ref = collection(assertDb(), COLLECTION);
  const q = query(ref, where("ownerId", "==", ownerId));
  const snap = await getDocs(q);
  return snap.docs.map((item) => mapPrivatePlaylist(item.id, item.data()));
}

export async function createPrivatePlaylist(input: {
  ownerId: string;
  ownerEmail?: string | null;
  nombre: string;
  iconUrl?: string | null;
  visibility?: PrivatePlaylistVisibility;
}) {
  const ref = await addDoc(collection(assertDb(), COLLECTION), {
    ownerId: input.ownerId,
    ownerEmail: input.ownerEmail || null,
    nombre: input.nombre,
    iconUrl: input.iconUrl || null,
    visibility: input.visibility || "private",
    songIds: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return ref.id;
}

export async function updatePrivatePlaylist(id: string, input: {
  nombre?: string;
  iconUrl?: string | null;
  visibility?: PrivatePlaylistVisibility;
}) {
  await updateDoc(doc(assertDb(), COLLECTION, id), {
    ...input,
    updatedAt: serverTimestamp(),
  });
}

export async function deletePrivatePlaylist(id: string) {
  await deleteDoc(doc(assertDb(), COLLECTION, id));
}

export async function getPrivatePlaylist(id: string) {
  const snap = await getDoc(doc(assertDb(), COLLECTION, id));
  if (!snap.exists()) return null;
  return mapPrivatePlaylist(snap.id, snap.data());
}

export async function addSongToPrivatePlaylist(id: string, songId: string) {
  await updateDoc(doc(assertDb(), COLLECTION, id), {
    songIds: arrayUnion(songId),
    updatedAt: serverTimestamp(),
  });
}

export async function removeSongFromPrivatePlaylist(id: string, songId: string) {
  await updateDoc(doc(assertDb(), COLLECTION, id), {
    songIds: arrayRemove(songId),
    updatedAt: serverTimestamp(),
  });
}
