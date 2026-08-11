import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type DocumentData,
  type QuerySnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

const COLLECTION = "hiddenSongs";

const assertDb = () => {
  if (!db) throw new Error("Firebase no esta configurado.");
  return db;
};

const hiddenIdsFromSnapshot = (snapshot: QuerySnapshot<DocumentData>) => snapshot.docs
  .map((item) => (item.data().songId as string) ?? item.id)
  .filter((songId): songId is string => typeof songId === "string");

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
  return hiddenIdsFromSnapshot(snap);
}

export function subscribeHiddenSongIds(
  onChange: (songIds: string[]) => void,
  onError?: () => void,
) {
  if (!db) {
    onChange([]);
    return () => undefined;
  }
  return onSnapshot(
    collection(db, COLLECTION),
    (snapshot) => onChange(hiddenIdsFromSnapshot(snapshot)),
    () => onError?.(),
  );
}
