import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

const COLLECTION = "hiddenSongs";

const assertDb = () => {
  if (!db) throw new Error("Firebase no esta configurado.");
  return db;
};

export async function hideSong(songId: string, hiddenByEmail?: string | null) {
  await setDoc(doc(assertDb(), COLLECTION, songId), {
    songId,
    hiddenBy: hiddenByEmail || null,
    createdAt: serverTimestamp(),
  });
}

export async function unhideSong(songId: string) {
  await deleteDoc(doc(assertDb(), COLLECTION, songId));
}

export async function listHiddenSongIds(): Promise<string[]> {
  if (!db) return [];
  const snap = await getDocs(collection(db, COLLECTION));
  return snap.docs
    .map((item) => (item.data().songId as string) ?? item.id)
    .filter((songId): songId is string => typeof songId === "string");
}
