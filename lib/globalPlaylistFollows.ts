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
  const q = query(collection(assertDb(), COLLECTION), where("userId", "==", userId));
  const snap = await getDocs(q);
  return snap.docs
    .map((item) => item.data().playlistId)
    .filter((playlistId): playlistId is string => typeof playlistId === "string");
}

export async function countGlobalPlaylistFollowers(playlistId: string) {
  const q = query(collection(assertDb(), COLLECTION), where("playlistId", "==", playlistId));
  const snap = await getDocs(q);
  return snap.size;
}
