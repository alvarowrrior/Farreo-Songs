import PlaylistLibrary from "@/components/PlaylistLibrary";
import AdminShortsEntry from "@/components/AdminShortsEntry";
import AdminSongContextEnhancer from "@/components/AdminSongContextEnhancer";

export default function AdminPage() {
  return (
    <>
      <AdminShortsEntry />
      <PlaylistLibrary adminMode />
      <AdminSongContextEnhancer />
    </>
  );
}
