// Thin S3 helpers for the note-attachment flow.
//
// Uploads happen via a presigned PUT URL handed to the browser — the file
// never travels through the Lambda, which means we sidestep the ~6 MB
// API Gateway sync invocation limit AND the Lambda memory cost on large
// files. This template targets generic apps (including media/video), so
// supporting big uploads out of the box is the priority.
//
// CORS: direct browser → S3 uploads ARE cross-origin, so the bucket has
// a permissive CORS rule (see hereya-aws-s3-shared hereyavars). The
// security analysis: presigned URLs are per-request SigV4 bearer auth,
// browsers refuse Allow-Origin=* + credentials, and uploads run with
// `credentials: 'omit'` — so wildcard CORS exposes nothing beyond what
// URL leakage would already expose (an attacker with a signed URL can
// curl it from anywhere). Tighten to specific origins in production if
// your compliance review flags wildcards.
//
// IAM: the workspace-level hereya/aws-s3-shared provides the bucket and
// emits `bucketArn` / `bucketName` to the env. This template layers
// hereya/aws-file-storage on top, which emits an `iamPolicyAwsS3Bucket`
// scoped to `<s3Prefix>/*` (GetObject / PutObject / DeleteObject /
// ListBucket) and gets auto-attached to both the Lambda role and the dev
// IAM user. Every object key built by this app starts with that prefix
// (see attachmentKey / withPrefix below).

import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let _client: S3Client | null = null;
function s3(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: process.env.AWS_REGION ?? process.env.awsRegion,
    });
  }
  return _client;
}

export function bucketName(): string {
  const b = process.env.bucketName;
  if (!b) throw new Error('bucketName env var missing');
  return b;
}

// Per-app prefix inside the shared bucket. Provided by the
// hereya/aws-file-storage package, which also emits a prefix-scoped IAM
// policy that gates Get/Put/Delete to `<prefix>/*` only. Every object
// key built by this app MUST start with `<prefix>/` or the IAM check
// will reject the operation.
//
// Empty string falls back gracefully (bucket-wide access via the
// looser aws-s3-shared policy) so this module still works in setups
// where the file-storage package isn't deployed.
function prefix(): string {
  return process.env.s3Prefix ?? '';
}

function withPrefix(key: string): string {
  const p = prefix();
  return p ? `${p}/${key}` : key;
}

// Strip path components and weird characters from a user-supplied filename
// so they can't escape the intended S3 prefix or break URL encoding. We
// keep dots (for extension), dashes, and underscores; replace anything
// else with `_`. If the result would be empty, fall back to `file`.
export function sanitizeFilename(input: string): string {
  const base = input.split('/').pop()?.split('\\').pop() ?? input;
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return cleaned || 'file';
}

// Object keys live under `<s3Prefix>/notes/<noteId>/<attachmentId>/<filename>`
// so that:
//   • The app's IAM policy (scoped to <s3Prefix>/*) covers the key.
//   • DELETE on a note can list and remove the noteId/ subprefix in bulk.
//   • Collisions across apps in the shared bucket are impossible (each
//     app has its own top-level prefix).
//   • Collisions within the app are impossible (the attachmentId is a UUID).
//   • Display filename survives the round-trip for nicer downloads.
export function attachmentKey(opts: {
  noteId: string;
  attachmentId: string;
  filename: string;
}): string {
  return withPrefix(
    `notes/${opts.noteId}/${opts.attachmentId}/${sanitizeFilename(opts.filename)}`,
  );
}

const PUT_URL_TTL_SECONDS = 15 * 60; // 15 min — accommodates slow uploads of larger files
const GET_URL_TTL_SECONDS = 5 * 60;

export interface PresignedPutOptions {
  key: string;
  contentType: string;
  contentLength: number;
}

export async function presignPut(opts: PresignedPutOptions): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: bucketName(),
    Key: opts.key,
    ContentType: opts.contentType,
    ContentLength: opts.contentLength,
  });
  return getSignedUrl(s3(), cmd, { expiresIn: PUT_URL_TTL_SECONDS });
}

export async function presignGet(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: bucketName(), Key: key });
  return getSignedUrl(s3(), cmd, { expiresIn: GET_URL_TTL_SECONDS });
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}
