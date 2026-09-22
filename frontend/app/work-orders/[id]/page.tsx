"use client";

import { useParams } from "next/navigation";
import { WorkOrderDetailScreen } from "@/components/screens/work-orders/work-order-detail-screen";

export default function WorkOrderDetailPage() {
  const params = useParams<{ id: string }>();
  return <WorkOrderDetailScreen woId={decodeURIComponent(params.id)} />;
}
