"use client";

import { useParams } from "next/navigation";
import RecommendationPlayer from "@/components/RecommendationPlayer";

export default function RecommendationPage() {
  const params = useParams<{ token: string }>();
  return <RecommendationPlayer token={decodeURIComponent(params.token)} />;
}
