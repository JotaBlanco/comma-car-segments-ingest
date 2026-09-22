import { SignalDetailScreen } from "@/components/screens/signals/signal-detail-screen";

interface SignalDetailPageProps {
  params: Promise<{ name: string }>;
}

export default async function SignalDetailPage({ params }: SignalDetailPageProps) {
  const { name } = await params;
  return <SignalDetailScreen name={decodeURIComponent(name)} />;
}
