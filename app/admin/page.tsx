import PlaylistLibrary from "@/components/PlaylistLibrary";
import AdminShortsEntry from "@/components/AdminShortsEntry";

export default function AdminPage() {
  return (
    <>
      <AdminShortsEntry />
      <PlaylistLibrary adminMode />
    </>
  );
}
