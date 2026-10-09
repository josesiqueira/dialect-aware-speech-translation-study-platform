import type { Metadata } from "next";
import { ReviewWorkspace } from "./_components/ReviewWorkspace";

export const metadata: Metadata = { title: "Review & Transcription" };

// /admin/review?utterance=<id> opens the review screen for that utterance.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { utterance } = await searchParams;
  const initialUtteranceId = typeof utterance === "string" && utterance.length > 0 ? utterance : null;
  return <ReviewWorkspace initialUtteranceId={initialUtteranceId} />;
}
