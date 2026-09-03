# Aragon Upload API (Express + Prisma + PostgreSQL + S3)

## Run locally

```bash
cd server
npm install
cat > .env <<'ENV'
DATABASE_URL="postgresql://user:pass@localhost:5432/aragon"
# Optional — omit to store files on local disk under server/uploads
AWS_REGION="us-east-1"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
S3_BUCKET="aragon-uploads"
ENV
npx prisma migrate dev --name init
npm start   # http://localhost:5000
```

## Endpoints

| Method | Path                                   | Description                                              |
| ------ | -------------------------------------- | -------------------------------------------------------- |
| POST   | `/api/upload`                          | multipart field `image`; 201 accepted / 422 rejected      |
| GET    | `/api/uploads?status=&limit=&offset=`  | paginated registry (indexed on `status, createdAt`)       |
| GET    | `/api/upload/:id`                      | single record (poll after async submit)                   |
| DELETE | `/api/upload/:id`                      | deletes DB row + stored object                            |

Send `Prefer: respond-async` on POST to get `202 PROCESSING` immediately and
poll `GET /api/upload/:id` while the queue finishes the work.

Dev sandbox override headers: `x-override-blur`, `x-override-small-face`,
`x-override-multi-face`, `x-override-duplicate`.

## Pipeline

1. MIME allowlist (JPEG/PNG/HEIC) enforced by multer `fileFilter` + pipeline.
2. HEIC/HEIF → JPEG via `heic-convert`.
3. Sharp metadata; reject `< 600x600`.
4. 64-bit average perceptual hash; Hamming distance ≤ 6 against recent accepted
   hashes → `DUPLICATE_IMAGE_DETECTION`.
5. Variance-of-Laplacian sharpness score; below threshold → `IMAGE_TOO_BLURRY`.
6. Face detection hook (`detectFaces`) → `MULTIPLE_FACES_DETECTED` /
   `FACE_TOO_SMALL`. Contract is `{ count, largestRatio }`; wire a real detector
   (AWS Rekognition, face-api) without touching the rest of the pipeline.
7. Accepted buffers are written to S3 (SSE-AES256) or the local fallback dir.

## Security

- memory storage only (no attacker-controlled temp paths), 120MB / 20 file caps
- MIME allowlist before buffering, key names sanitised, `x-powered-by` disabled
- configurable CORS origin, server-side re-validation independent of the client

## Frontend wiring

The React app posts to `/api/public/upload` (an edge-runtime mirror with an
identical request/response contract) so the hosted preview works without a Node
host. Point `VITE_UPLOAD_ENDPOINT` at `http://localhost:5000/api/upload` to
drive this Express service instead.
