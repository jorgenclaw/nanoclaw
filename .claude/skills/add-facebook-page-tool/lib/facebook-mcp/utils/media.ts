import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { FacebookClient } from "../client.js";

// NanoClaw patch: upload a local photo or video file straight to the Page.
// Upstream only took a public image URL. The Graph API has multipart upload
// endpoints for both (POST /{page-id}/photos and /{page-id}/videos), so no
// separate hosting step is needed. Facebook has no audio post type, so audio
// files are rejected with a clear message rather than attempted.

const PHOTO_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};
const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".aac"]);

// Facebook's limits for a single (non-resumable) upload.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

type MediaKind = "photo" | "video";

const detectMedia = (path: string): { kind: MediaKind; type: string } => {
  const ext = extname(path).toLowerCase();
  if (PHOTO_TYPES[ext]) return { kind: "photo", type: PHOTO_TYPES[ext] };
  if (VIDEO_TYPES[ext]) return { kind: "video", type: VIDEO_TYPES[ext] };
  if (AUDIO_EXTS.has(ext)) {
    throw new Error(
      "Facebook Pages can't post audio files. Turn it into a video first (for example a still image with the sound), or post a link to it.",
    );
  }
  throw new Error(
    `Unsupported media file type "${ext || "(none)"}". Photos: ${Object.keys(PHOTO_TYPES).join(" ")}. Videos: ${Object.keys(VIDEO_TYPES).join(" ")}.`,
  );
};

interface UploadOptions {
  message?: string;
  // UNIX seconds; when set, the post is created unpublished and scheduled.
  scheduledPublishTime?: string;
}

// Type + existence + size check, before anything is sent.
const checkMediaFile = (path: string): { kind: MediaKind; type: string } => {
  const { kind, type } = detectMedia(path);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`Cannot read media file ${path} (does it exist inside the container?)`);
  }
  const max = kind === "photo" ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
  if (size > max) {
    throw new Error(
      `${kind === "photo" ? "Photo" : "Video"} is ${(size / 1024 / 1024).toFixed(1)} MB; Facebook's limit is ${max / 1024 / 1024} MB.`,
    );
  }
  return { kind, type };
};

const uploadMedia = async (
  client: FacebookClient,
  path: string,
  { message, scheduledPublishTime }: UploadOptions,
) => {
  const { kind, type } = checkMediaFile(path);

  const form = new FormData();
  form.append("source", new Blob([readFileSync(path)], { type }), basename(path));
  // Photos take the post text as `message`; videos call it `description`.
  if (message) form.append(kind === "photo" ? "message" : "description", message);
  if (scheduledPublishTime) {
    form.append("published", "false");
    form.append("scheduled_publish_time", scheduledPublishTime);
  }

  const { pageId } = client.config;
  return client.request(`/${pageId}/${kind === "photo" ? "photos" : "videos"}`, {
    method: "POST",
    body: form,
  });
};

// NanoClaw patch: several photos in one post. The Graph API has no single
// multi-file upload, so each photo goes to /{page-id}/photos unpublished, then
// one /{page-id}/feed post attaches them all via attached_media. A scheduled
// post needs its photos uploaded with temporary=true. Videos can't be attached
// this way, so multi-file posts are photos only.
const MAX_PHOTOS_PER_POST = 10;

const uploadPhotoPost = async (
  client: FacebookClient,
  paths: string[],
  { message, scheduledPublishTime }: UploadOptions,
) => {
  if (paths.length < 2 || paths.length > MAX_PHOTOS_PER_POST) {
    throw new Error(`A multi-photo post takes 2 to ${MAX_PHOTOS_PER_POST} photos; got ${paths.length}.`);
  }
  // Check every file first so a bad path doesn't leave half the photos uploaded.
  const files = paths.map((path) => {
    const { kind, type } = checkMediaFile(path);
    if (kind !== "photo") {
      throw new Error(
        `${basename(path)} is a video. A post with several files can only hold photos; post the video on its own.`,
      );
    }
    return { path, type };
  });

  const { pageId } = client.config;
  const photoIds: string[] = [];
  for (const { path, type } of files) {
    const form = new FormData();
    form.append("source", new Blob([readFileSync(path)], { type }), basename(path));
    form.append("published", "false");
    if (scheduledPublishTime) form.append("temporary", "true");
    try {
      const { id } = (await client.request(`/${pageId}/photos`, { method: "POST", body: form })) as { id: string };
      photoIds.push(id);
    } catch (e) {
      throw new Error(
        `Uploading ${basename(path)} failed after ${photoIds.length} of ${files.length} photos; nothing was posted. ${(e as Error).message}`,
      );
    }
  }

  const body: Record<string, unknown> = {
    attached_media: photoIds.map((id) => ({ media_fbid: id })),
  };
  if (message) body.message = message;
  if (scheduledPublishTime) {
    body.published = false;
    body.scheduled_publish_time = scheduledPublishTime;
  }
  const result = await client.request(`/${pageId}/feed`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { ...(result as object), photo_ids: photoIds };
};

export { detectMedia, MAX_PHOTOS_PER_POST, uploadMedia, uploadPhotoPost };
