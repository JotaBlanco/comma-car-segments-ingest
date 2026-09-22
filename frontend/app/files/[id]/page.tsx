import { FileDetailScreen } from "@/components/screens/files/file-detail-screen";

interface FileDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function FileDetailPage({ params }: FileDetailPageProps) {
  const { id } = await params;
  return <FileDetailScreen fileId={decodeURIComponent(id)} />;
}
