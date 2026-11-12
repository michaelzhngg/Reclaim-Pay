import { cookies } from "next/headers";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

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

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
