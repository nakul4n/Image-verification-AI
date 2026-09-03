# Aragon.ai Photo Verification & Onboarding Pipeline

A production-grade, full-stack photo ingestion and verification engine engineered for AI portrait generation workflows (Aragon.ai style). The system provides automated image engineering validations, stream decoding, perceptual similarity indexing, and asynchronous background processing.

---

## Architecture Overview

The system is decoupled into two primary layers:
1. **Frontend Client**: React 19 + TanStack Start + Tailwind CSS + Radix UI providing an interactive drag-and-drop upload wizard with real-time rejection feedback and development override controls.
2. **Backend Engine**: Node.js + Express + Sharp + Prisma ORM + PostgreSQL with an in-memory stream pipeline, S3 storage abstraction, and an OpenAI Vision integration (`gpt-4o-mini`).

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Upload Wizard (Client)                         │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ POST /api/upload (multipart/form-data)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Express API & Ingestion Router                      │
│   - Multer MemoryStorage (120MB cap, zero disk temp files)              │
│   - Initial MIME Allowlist Filtering                                    │
│   - Synchronous or Async Execution (Prefer: respond-async)              │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                Decoupled Background Queue (queue.js)                    │
│   - Bounded Concurrency Worker Pool (UPLOAD_CONCURRENCY)                │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 Image Engineering Validation Pipeline                   │
│                                                                         │
│   1. HEIC Normalization       ──► heicConvert (HEIC/HEIF -> JPEG Buffer)│
│   2. Resolution Guard         ──► Sharp metadata (Min 600x600 px)       │
│   3. Perceptual Hash (aHash)  ──► 64-bit greyscale 8x8 binary vector    │
│   4. Hamming Distance Check   ──► Distance <= 6 bits vs indexed hashes  │
│   5. Laplacian Blur Score     ──► Variance-of-Laplacian (cutoff >= 90)  │
│   6. AI Vision Face Check     ──► OpenAI Vision (gpt-4o-mini)           │
│                                   (Single face >= 8% frame area)        │
└──────────────────┬──────────────────────────────────┬───────────────────┘
                   │                                  │
                   ▼ (Accepted)                       ▼ (Metadata)
┌──────────────────────────────────────┐ ┌────────────────────────────────┐
│      Storage Layer (storage.js)      │ │   PostgreSQL Database (Prisma) │
│  - Amazon S3 (SSE-AES256)            │ │  - ImageUpload table           │
│  - Local Disk Buffer Fallback        │ │  - @@index([imageHash])        │
│                                      │ │  - @@index([status, createdAt])│
└──────────────────────────────────────┘ └────────────────────────────────┘
```

---

## Core Engineering Features

### 1. Decoupled Background Concurrency Queue (`server/services/queue.js`)
- **Bounded Concurrency**: Uses an in-process concurrency queue manager with configurable worker capacity (`UPLOAD_CONCURRENCY=3`) to prevent CPU starvation during heavy Sharp/HEIC transformations.
- **Async Execution Mode**: Supports `Prefer: respond-async` header. Returns `202 Accepted` immediately with record metadata, delegating transformations to the background queue while clients poll `GET /api/upload/:id`.
- **Horizontal Scalability**: Queue interface is designed as a drop-in replacement for Redis/BullMQ or AWS SQS in multi-instance cluster deployments.

### 2. Perceptual Hashing & Hamming Distance Duplicate Detection
- **64-bit Average Hash (`aHash`)**: Compresses image buffers into 8x8 greyscale raw pixel arrays and computes binary threshold vectors against mean pixel values, yielding a 16-character hexadecimal hash.
- **Hamming Distance Bitwise Calculation**: Computes bit-difference distance via XOR operations. Any pair with `distance <= 6` bits is rejected as `DUPLICATE_IMAGE_DETECTION`.
- **Relational PostgreSQL Indexing**: Database schema explicitly indexes `imageHash` (`@@index([imageHash])`) and status-timestamp tuples (`@@index([status, createdAt])`) for low-latency similarity queries.

### 3. HEIC Stream Normalization & Image Pipeline (`server/services/imagePipeline.js`)
- **MIME Allowlist**: Accepts `image/jpeg`, `image/jpg`, `image/png`, `image/heic`, `image/heif`, `image/x-mac-heic`.
- **Native HEIC Stream Decoding**: Transcodes Apple HEIC/HEIF containers directly into JPEG buffers using `heic-convert` without persisting raw files to temporary OS disk locations.
- **Variance-of-Laplacian Sharpness**: Convolves 512x512 greyscale buffers with a Laplacian kernel to calculate edge variance. Rejects blurry frames (`sharpness < 90`) with `IMAGE_TOO_BLURRY`.
- **OpenAI Vision Face Analysis (`gpt-4o-mini`)**:
  - Enforces single human subject constraints (`count === 1`).
  - Evaluates bounding box area coverage against the frame (`largestRatio >= 0.08`).
  - Flags `NO_FACE_DETECTED`, `MULTIPLE_FACES_DETECTED`, or `FACE_TOO_SMALL`.

### 4. Storage Abstraction Layer (`server/services/storage.js`)
- **AWS S3 Integration**: Automatically uploads accepted assets to Amazon S3 with server-side encryption (`AES256`) when `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `S3_BUCKET` are set.
- **Zero-Setup Disk Fallback**: Seamlessly falls back to local disk storage (`server/uploads/`) for local development without cloud dependencies.

---

## API Reference

### Endpoints

| Method | Endpoint | Description | Request Body / Headers | Response Status |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/upload` | Upload & validate image | `multipart/form-data` with `image` file | `201 Created` / `422 Unprocessable` / `202 Accepted` |
| `GET` | `/api/uploads` | Paginated uploads list | Query: `?status=&limit=&offset=` | `200 OK` |
| `GET` | `/api/upload/:id` | Get upload status | Route param: `:id` (UUID) | `200 OK` / `404 Not Found` |
| `DELETE` | `/api/upload/:id` | Delete upload & object | Route param: `:id` (UUID) | `200 OK` / `404 Not Found` |

### Dev Sandbox Override Headers
For manual testing and verification, the backend accepts override headers:
- `x-override-blur: true` — Triggers `IMAGE_TOO_BLURRY`
- `x-override-small-face: true` — Triggers `FACE_TOO_SMALL`
- `x-override-multi-face: true` — Triggers `MULTIPLE_FACES_DETECTED`
- `x-override-duplicate: true` — Triggers `DUPLICATE_IMAGE_DETECTION`

---

## Environment Variables

### Root (`.env`)
```env
VITE_UPLOAD_ENDPOINT=http://localhost:5000/api/upload
```

### Backend (`server/.env`)
```env
PORT=5000
DATABASE_URL="postgresql://postgres:your_password@localhost:5432/aragon_clone?schema=public"
S3_BUCKET=aragon-onboarding-uploads
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
OPENAI_API_KEY=your_openai_key
CORS_ORIGIN=http://localhost:8080
UPLOAD_CONCURRENCY=3
```

---

## Getting Started

### 1. Clone & Install Dependencies

```bash
# Frontend dependencies
npm install

# Backend dependencies
cd server
npm install
cd ..
```

### 2. Database Migration (PostgreSQL + Prisma)

```bash
cd server
npx prisma generate
npx prisma migrate dev --name init
cd ..
```

### 3. Run Development Servers

Start the backend service:
```bash
cd server
npm start
# Express running on http://localhost:5000
```

In a separate terminal, start the frontend client:
```bash
npm run dev
# Vite dev server running on http://localhost:8080 (or configured port)
```

---

## Production Deployment

### Backend Service
Deploy `server/` to any Node.js runtime (AWS ECS, Render, Fly.io, Railway, or EC2):
```bash
cd server
npm install --production
npx prisma migrate deploy
node server.js
```

### Frontend Client
Build static assets or deploy SSR bundle:
```bash
npm run build
```

---

## License

MIT License. Designed for Aragon.ai style photo verification workflows.
