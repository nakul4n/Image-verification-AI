import { createFileRoute } from "@tanstack/react-router";
import { UploadWizard } from "@/components/upload/UploadWizard";

const title = "Upload photos — Aragon.ai AI Headshot Studio";
const description =
  "Upload at least 6 photos and our validation pipeline scores each one for focus, framing, face size and duplicates before generating your AI headshots.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return <UploadWizard />;
}
