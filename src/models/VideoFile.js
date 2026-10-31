import mongoose from 'mongoose';

const VideoFileSchema = new mongoose.Schema(
  {
    batchId: {
      type: String,
      required: true,
      index: true
    },
    originalName: {
      type: String,
      required: true
    },
    relativePath: {
      type: String,
      default: ''
    },
    seriesId: {
      type: String,
      required: true,
      index: true
    },
    partNumber: {
      type: Number,
      required: true,
      default: 1
    },
    filePath: {
      type: String,
      required: true
    },
    fileSize: {
      type: Number,
      default: 0
    },
    duration: {
      type: Number,
      default: 0
    },
    videoCodec: {
      type: String,
      default: ''
    },
    audioCodec: {
      type: String,
      default: ''
    },
    width: {
      type: Number,
      default: 0
    },
    height: {
      type: Number,
      default: 0
    },
    fps: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: ['uploaded', 'analyzed', 'error'],
      default: 'uploaded'
    }
  },
  {
    timestamps: true
  }
);

export const VideoFile = mongoose.model('VideoFile', VideoFileSchema);
