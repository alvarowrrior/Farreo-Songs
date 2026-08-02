import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

const COLLECTION = "globalPlaylistFollows";

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
}

export async function unfollowGlobalPlaylist(userId: string, playlistId: string) {
  await deleteDoc(doc(assertDb(), COLLECTION, followDocId(userId, playlistId)));
}

export async function isFollowingGlobalPlaylist(userId: string, playlistId: string) {
  const snap = await getDoc(doc(assertDb(), COLLECTION, followDocId(userId, playlistId)));
  return snap.exists();
}

export async function listFollowedGlobalPlaylistIds(userId: string) {
  const followed = await listFollowedGlobalPlaylists(userId);
  return followed.map((item) => item.playlistId);
}

export async function listFollowedGlobalPlaylists(userId: string) {
  const q = query(collection(assertDb(), COLLECTION), where("userId", "==", userId));
  const snap = await getDocs(q);
  return snap.docs
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
}

export async function touchFollowedGlobalPlaylist(userId: string, playlistId: string) {
  await setDoc(doc(assertDb(), COLLECTION, followDocId(userId, playlistId)), {
    lastOpenedAt: serverTimestamp(),
  }, { merge: true });
}

export async function countGlobalPlaylistFollowers(playlistId: string) {
  const q = query(collection(assertDb(), COLLECTION), where("playlistId", "==", playlistId));
  const snap = await getDocs(q);
  return snap.size;
}
