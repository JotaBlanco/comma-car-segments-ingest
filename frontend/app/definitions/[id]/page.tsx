import { DefinitionDetailScreen } from "@/components/screens/definitions/definition-detail-screen";

interface DefinitionDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function DefinitionDetailPage({ params }: DefinitionDetailPageProps) {
  const { id } = await params;
  return <DefinitionDetailScreen tdId={decodeURIComponent(id)} />;
}
