import mongoose from 'mongoose';

const MergeJobSchema = new mongoose.Schema(
  {
    batchId: {
      type: String,
      required: true,
      index: true
    },
    seriesId: {
      type: String,
      required: true,
      index: true
    },
    inputFileIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'VideoFile'
      }
    ],
    outputFilePath: {
      type: String,
      default: null
    },
    outputFileName: {
      type: String,
      default: null
    },
    outputFileSize: {
      type: Number,
      default: 0
    },
    outputDuration: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'],
      default: 'queued',
      index: true
    },
    progress: {
      type: Number,
      default: 0
    },
    stage: {
      type: String,
      default: 'Queued'
    },
    isTranscoded: {
      type: Boolean,
      default: false
    },
    transcodeReason: {
      type: String,
      default: null
    },
    startedAt: {
      type: Date,
      default: null
    },
    completedAt: {
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
    errorMessage: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true
  }
);

export const MergeJob = mongoose.model('MergeJob', MergeJobSchema);
