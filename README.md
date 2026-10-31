# FASTBATCH Backend API

Smart Bulk Video Merger Backend powered by Node.js, Express, MongoDB, and FFmpeg.

## 🚀 Overview

FASTBATCH backend processes batch video uploads, identifies multi-part video series, detects and numerically sorts part numbers, and merges them using high-speed lossless FFmpeg stream copy (`-c copy`) or compatibility transcoding.

## ✨ Key Features

- **Streaming Video Uploads**: Handles large multi-file and folder uploads (up to 1 TB batch capacity) with backpressure to avoid RAM saturation.
- **Smart Filename Detection**: Groups video files by series identity and sorts part numbers strictly numerically.
- **FFmpeg Concat Engine**:
  - **Lossless Stream Copy (`-c copy`)**: Fast concatenation for compatible video codecs without re-encoding.
  - **Safe Normalization Transcoding**: Scales and normalizes varying resolutions, frame rates, and missing audio channels when needed.
- **Real-Time Progress**: Parses FFmpeg progress output to calculate exact completion percentages.
- **Automated Retention & Cleanup**: Cleans up output files 10 minutes after processing, with active download lease protection.
- **ZIP Archiving**: On-the-fly streaming of merged series bundles.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express.js
- **Database**: MongoDB (via Mongoose)
- **Video Engine**: FFmpeg & FFprobe
- **File Handling**: Multer & Archiver

---

## 📋 Prerequisites

1. **Node.js**: v18.0.0 or higher
2. **MongoDB**: Local MongoDB instance (`mongodb://127.0.0.1:27017`) or MongoDB Atlas
3. **FFmpeg & FFprobe**: Installed and available in PATH (or configured via environment variables)

---

## ⚙️ Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Default configuration variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | Server listening port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/video_merger` | MongoDB connection URI |
| `CLIENT_URL` | `http://localhost:5173` | Allowed CORS client URL |
| `MAX_BATCH_SIZE_GB` | `1024` | Maximum total upload size per batch in GB (1 TB) |
| `MAX_FILES_PER_BATCH` | `10000` | Maximum number of files per batch |
| `FILE_RETENTION_MINUTES` | `10` | Output file expiration time after completion |
| `TEMP_DIR` | `./temp` | Temporary processing and storage directory |
| `FFMPEG_PATH` | `ffmpeg` | Path or binary name for FFmpeg |
| `FFPROBE_PATH` | `ffprobe` | Path or binary name for FFprobe |
| `MAX_CONCURRENT_MERGES` | `2` | Number of simultaneous merge operations |

---

## 📦 Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Run Development Server

```bash
npm run dev
```

The server starts on `http://localhost:5000` with hot-reloading.

### 3. Production Start

```bash
npm start
```

---

## 📡 API Endpoints

- `GET /api/health` - Server health status and storage info
- `POST /api/batches/upload` - Upload video files / folder structure
- `GET /api/batches/:batchId` - Fetch batch details and series groups
- `POST /api/batches/:batchId/merge` - Start video merge jobs
- `GET /api/batches/:batchId/status` - Live merge progress tracking
- `GET /api/batches/:batchId/download/:seriesId` - Download individual merged series MP4
- `GET /api/batches/:batchId/download-all` - Download all completed series as ZIP

---

## 📄 License

MIT
