# Photo Pipeline Pro - Automated Photo Verification Engine

A production-grade full-stack photo ingestion and verification pipeline built with TanStack Start, React, Vite, Express, and Prisma.

## Architecture

- **Frontend**: TanStack Start / React 19 / Tailwind CSS
- **Backend**: Node.js / Express / Prisma ORM / Sharp
- **Pipeline Validations**:
  - MIME type filtering (JPEG, PNG, WebP, HEIC/HEIF)
  - Automatic HEIC conversion to high-quality JPEG
  - Minimum resolution verification (>= 600x600)
  - Perceptual 64-bit hashing & Hamming duplicate detection
  - Laplacian variance sharpness / blur scoring
  - Face presence, count, and ratio validation
  - Simulated developer sandbox overrides

## Quick Start

### 1. Frontend Client
```bash
npm install
npm run dev # http://localhost:5173
```

### 2. Backend Service
```bash
cd server
npm install
npm start   # http://localhost:5001
```
