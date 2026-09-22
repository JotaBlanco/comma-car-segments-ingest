import { LineageScreen } from "@/components/screens/lineage/lineage-screen";

export default async function RunLineagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LineageScreen runId={decodeURIComponent(id)} />;
}
