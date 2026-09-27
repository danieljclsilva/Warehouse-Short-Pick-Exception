import { authenticate } from "@/server/auth";
import { handleRouteError, jsonError } from "@/server/http";
import { removeProfilePhoto, uploadProfilePhoto, getProfilePhoto, parseBoundedMultipartFormData, MULTIPART_OVERHEAD_LIMIT_BYTES } from "@/server/profile-photos";
import { getSelfProfile } from "@/server/profile";
import { getCurrentConfiguration } from "@/server/configuration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const { values } = await getCurrentConfiguration();
    const maxUploadBytes = values.PROFILE_PHOTO_MAX_UPLOAD_BYTES;
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxUploadBytes + MULTIPART_OVERHEAD_LIMIT_BYTES) {
      return jsonError("Photo upload exceeds the configured size limit", 413);
    }
    const form = await parseBoundedMultipartFormData(request, maxUploadBytes);
    const file = form.get("photo");
    if (!(file instanceof File)) return jsonError("Upload a photo in the photo field", 400);
    await uploadProfilePhoto(auth, file, maxUploadBytes);
    return Response.json({ profile: await getSelfProfile(auth) }, { status: 201, headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}

export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    const userId = new URL(request.url).searchParams.get("userId") || auth.user.id;
    const photo = await getProfilePhoto(auth, userId);
    return new Response(photo.body as BodyInit, { headers: { "content-type": photo.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) { return handleRouteError(error); }
}

export async function DELETE(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return jsonError("Unauthenticated", 401);
    await removeProfilePhoto(auth);
    return Response.json({ profile: await getSelfProfile(auth) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
