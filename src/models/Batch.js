import mongoose from 'mongoose';

const BatchSchema = new mongoose.Schema(
  {
    batchId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    token: {
      type: String,
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ['uploading', 'ready', 'processing', 'completed', 'failed', 'expired'],
      default: 'uploading',
      index: true
    },
    totalFiles: {
      type: Number,
      default: 0
    },
    totalSize: {
      type: Number,
      default: 0
    },
    uploadCompletedAt: {
      type: Date,
      default: null
    },
    mergeStartedAt: {
      type: Date,
      default: null
    },
    outputReadyAt: {
      type: Date,
      default: null
    },
    elapsedSeconds: {
      type: Number,
      default: 0
    },
    completedWithinTarget: {
      type: Boolean,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true
    },
    errorMessage: {
      type: String,
      default: null
    },
    cleanupStatus: {
      type: String,
      enum: ['pending', 'cleaned', 'failed'],
      default: 'pending',
      index: true
    }
  },
  {
    timestamps: true
  }
);

export const Batch = mongoose.model('Batch', BatchSchema);
