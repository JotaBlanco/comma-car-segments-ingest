import { Suspense } from "react";
import { IssueDetailScreen } from "@/components/screens/issues/issue-detail-screen";

export default async function IssuePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  return (
    <Suspense>
      <IssueDetailScreen issueId={Number(id)} from={from ?? null} />
    </Suspense>
  );
}
