import express from 'express';
import { upload } from '../middleware/uploadMiddleware.js';
import {
  uploadBatch,
  getBatch,
  getBatchFiles,
  getBatchGroups,
  updateBatchGroups,
  startBatchMerge,
  getBatchProgress,
  getBatchResults,
  downloadOutputFile,
  downloadAllZip,
  deleteBatch
} from '../controllers/batchController.js';

const router = express.Router();

// Bulk & folder upload
router.post('/', upload.array('videos'), uploadBatch);

// Batch details and status
router.get('/:batchId', getBatch);

// Files in batch
router.get('/:batchId/files', getBatchFiles);

// Detected series groups
router.get('/:batchId/groups', getBatchGroups);

// Update/correct series groups manually
router.put('/:batchId/groups', updateBatchGroups);

// Start merge
router.post('/:batchId/merge', startBatchMerge);

// Live progress (JSON polling or SSE)
router.get('/:batchId/progress', getBatchProgress);

// Final completed results
router.get('/:batchId/results', getBatchResults);

// Secure streaming download of merged video
router.get('/:batchId/download/:jobId', downloadOutputFile);

// Stream all completed videos as a single ZIP
router.get('/:batchId/download-all', downloadAllZip);

// Cancel and delete batch
router.delete('/:batchId', deleteBatch);

export default router;
