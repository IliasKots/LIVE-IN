import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Presigned GET for one private R2 object (S3 SigV4 query signing by the official AWS SDK).
// Credentials must belong to an R2 token limited to Object Read on the package bucket.
export function createR2Signer({ endpoint, accessKeyId, secretAccessKey }) {
  const client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    // R2 does not need the SDK's optional CRC checksum parameters; keep the URL a plain GET.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return async function sign({ bucket, key, expiresIn, signingDate }) {
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn, signingDate });
  };
}
