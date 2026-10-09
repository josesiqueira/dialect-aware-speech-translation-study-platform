import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RecorderDevPage } from "./RecorderDevPage";

export const metadata: Metadata = { title: "Recorder test page" };

/**
 * Developer page for checking audio capture on a real device (docs/AUDIO-CAPTURE.md,
 * "Validating capture on the study laptop"). It sends no audio anywhere.
 * Not available in production.
 */
export default function RecorderDevRoute() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <RecorderDevPage />;
}
