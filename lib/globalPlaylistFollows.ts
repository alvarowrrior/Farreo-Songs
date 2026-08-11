import {
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

const COLLECTION = "globalPlaylistFollows";
const CACHE_TTL_MS = 60_000;

const followedCache = new Map<string, { expiresAt: number; items: FollowedGlobalPlaylist[] }>();
const followedPending = new Map<string, Promise<FollowedGlobalPlaylist[]>>();
const followerCountCache = new Map<string, { expiresAt: number; count: number }>();

const assertDb = () => {
  if (!db) throw new Error("Firebase no esta configurado.");
  return db;
};

const followDocId = (userId: string, playlistId: string) =>
  `${encodeURIComponent(userId)}_${encodeURIComponent(playlistId)}`;

export interface FollowedGlobalPlaylist {
  playlistId: string;
  followedAt: string | null;
  lastOpenedAt: string | null;
}

const timestampToIso = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;

  const timestamp = value as { seconds?: unknown; toDate?: () => Date };
  if (typeof timestamp.toDate === "function") return timestamp.toDate().toISOString();
  if (typeof timestamp.seconds === "number") return new Date(timestamp.seconds * 1000).toISOString();
  return null;
};

const invalidateUser = (userId: string) => {
  followedCache.delete(userId);
  followedPending.delete(userId);
};

const invalidateCount = (playlistId: string) => followerCountCache.delete(playlistId);

export async function followGlobalPlaylist(input: {
  userId: string;
  userEmail?: string | null;
  playlistId: string;
}) {
  await setDoc(doc(assertDb(), COLLECTION, followDocId(input.userId, input.playlistId)), {
    userId: input.userId,
    userEmail: input.userEmail || null,
    playlistId: input.playlistId,
    createdAt: serverTimestamp(),
    lastOpenedAt: serverTimestamp(),
  });
  invalidateUser(input.userId);
  invalidateCount(input.playlistId);
}

export async function unfollowGlobalPlaylist(userId: string, playlistId: string) {
  await deleteDoc(doc(assertDb(), COLLECTION, followDocId(userId, playlistId)));
  invalidateUser(userId);
  invalidateCount(playlistId);
}

export async function isFollowingGlobalPlaylist(userId: string, playlistId: string) {
  const cached = followedCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.items.some((item) => item.playlistId === playlistId);
  }
  const snap = await getDoc(doc(assertDb(), COLLECTION, followDocId(userId, playlistId)));
  return snap.exists();
}

export async function listFollowedGlobalPlaylistIds(userId: string) {
  const followed = await listFollowedGlobalPlaylists(userId);
  return followed.map((item) => item.playlistId);
}

export async function listFollowedGlobalPlaylists(userId: string) {
  const cached = followedCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  const pending = followedPending.get(userId);
  if (pending) return pending;

  const request = (async () => {
    const q = query(collection(assertDb(), COLLECTION), where("userId", "==", userId));
    const snap = await getDocs(q);
    const items = snap.docs
      .map((item) => {
        const data = item.data();
        if (typeof data.playlistId !== "string") return null;
        return {
          playlistId: data.playlistId,
          followedAt: timestampToIso(data.createdAt),
          lastOpenedAt: timestampToIso(data.lastOpenedAt),
        };
      })
      .filter((item): item is FollowedGlobalPlaylist => Boolean(item));
    followedCache.set(userId, { expiresAt: Date.now() + CACHE_TTL_MS, items });
    return items;
  })().finally(() => followedPending.delete(userId));

  followedPending.set(userId, request);
  return request;
}

export async function touchFollowedGlobalPlaylist(userId: string, playlistId: string) {
  await setDoc(doc(assertDb(), COLLECTION, followDocId(userId, playlistId)), {
    lastOpenedAt: serverTimestamp(),
  }, { merge: true });
  invalidateUser(userId);
}

export async function countGlobalPlaylistFollowers(playlistId: string) {
  const cached = followerCountCache.get(playlistId);
  if (cached && cached.expiresAt > Date.now()) return cached.count;

  // Aggregation count avoids downloading every follower document just to know
  // how many there are.
  const q = query(collection(assertDb(), COLLECTION), where("playlistId", "==", playlistId));
  const snap = await getCountFromServer(q);
  const count = snap.data().count;
  followerCountCache.set(playlistId, { expiresAt: Date.now() + CACHE_TTL_MS, count });
  return count;
}
