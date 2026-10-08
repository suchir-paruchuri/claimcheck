import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';

const s3 = new S3Client({ region: config.aws.region });

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Short-lived URL the browser uses to upload the PDF straight to S3, so large files
 * never pass through the Express server. A lifecycle rule on the bucket's uploads/
 * prefix deletes originals after 30 days (see README).
 */
export async function presignUpload(key: string): Promise<string> {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: config.aws.bucket, Key: key, ContentType: 'application/pdf' }), { expiresIn: 300 });
}

export async function downloadFile(key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: config.aws.bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty S3 object ${key}`);
  const bytes = await res.Body.transformToByteArray();
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('Uploaded file is larger than 15 MB');
  return bytes;
}

export async function deleteFile(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: config.aws.bucket, Key: key }));
}
