"use client";

import { useParams } from "next/navigation";
import { RequirementDetailScreen } from "@/components/screens/requirements/requirement-detail-screen";

export default function RequirementDetailPage() {
  const params = useParams<{ reqId: string }>();
  return <RequirementDetailScreen reqId={decodeURIComponent(params.reqId)} />;
}
