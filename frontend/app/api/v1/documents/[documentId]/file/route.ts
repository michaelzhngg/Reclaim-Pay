import { cookies } from "next/headers";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// Only images and PDFs render inline. Anything else (an uploaded .html or .svg) would run as
// script on this domain when HR opens it, so it is sent as a download instead.
const INLINE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "application/pdf",
]);

/** Streams a receipt file from the backend, passing the signed-in user's session token. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const { documentId } = await params;
  const token = (await cookies()).get("session")?.value;
  if (!token) return new Response("Not signed in", { status: 401 });

  const backendUrl =
    process.env.INTERNAL_API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:8000";

  const upstream = await fetch(
    `${backendUrl}/api/v1/documents/${encodeURIComponent(documentId)}/file`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
  );
  if (!upstream.ok || !upstream.body) {
    return new Response("Receipt unavailable", { status: upstream.status === 200 ? 502 : upstream.status });
  }

  const upstreamType = (upstream.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  const inline = INLINE_TYPES.has(upstreamType);
  return new Response(upstream.body, {
    headers: {
      "Content-Type": inline ? upstreamType : "application/octet-stream",
      ...(inline ? {} : { "Content-Disposition": "attachment" }),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
