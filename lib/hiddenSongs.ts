import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  type DocumentData,
  type QuerySnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

const COLLECTION = "hiddenSongs";
const CACHE_TTL_MS = 60_000;

let cachedHiddenIds: string[] | null = null;
let cacheExpiresAt = 0;
let pendingHiddenIds: Promise<string[]> | null = null;

const assertDb = () => {
  if (!db) throw new Error("Firebase no esta configurado.");
  return db;
};

const hiddenIdsFromSnapshot = (snapshot: QuerySnapshot<DocumentData>) => snapshot.docs
  .map((item) => (item.data().songId as string) ?? item.id)
  .filter((songId): songId is string => typeof songId === "string");

const rememberHiddenIds = (ids: string[]) => {
  cachedHiddenIds = [...new Set(ids)];
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return [...cachedHiddenIds];
};

export function invalidateHiddenSongsCache() {
  cachedHiddenIds = null;
  cacheExpiresAt = 0;
  pendingHiddenIds = null;
}

export async function hideSong(songId: string, hiddenByEmail?: string | null) {
  await setDoc(doc(assertDb(), COLLECTION, songId), {
    songId,
    hiddenBy: hiddenByEmail || null,
    createdAt: serverTimestamp(),
  });

  if (cachedHiddenIds) {
    rememberHiddenIds([...cachedHiddenIds, songId]);
  } else {
    invalidateHiddenSongsCache();
  }
}

export async function unhideSong(songId: string) {
  await deleteDoc(doc(assertDb(), COLLECTION, songId));

  if (cachedHiddenIds) {
    rememberHiddenIds(cachedHiddenIds.filter((id) => id !== songId));
  } else {
    invalidateHiddenSongsCache();
  }
}

export async function listHiddenSongIds(force = false): Promise<string[]> {
  if (!db) return [];

  if (!force && cachedHiddenIds && Date.now() < cacheExpiresAt) {
    return [...cachedHiddenIds];
  }

  if (!force && pendingHiddenIds) {
    return pendingHiddenIds.then((ids) => [...ids]);
  }

  const request = getDocs(collection(db, COLLECTION))
    .then((snapshot) => rememberHiddenIds(hiddenIdsFromSnapshot(snapshot)))
    .finally(() => {
      if (pendingHiddenIds === request) pendingHiddenIds = null;
    });

  pendingHiddenIds = request;
  return request.then((ids) => [...ids]);
}
