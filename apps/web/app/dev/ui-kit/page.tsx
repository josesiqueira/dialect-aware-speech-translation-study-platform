import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UiKit } from "./UiKit";

export const metadata: Metadata = { title: "UI kit" };

/** Developer page for visual review of every primitive. Not available in production. */
export default function UiKitPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <UiKit />;
}
