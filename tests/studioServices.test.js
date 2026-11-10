import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { config } from '../src/config/env.js';
import { removeAudioNoise } from '../src/services/studio/audioNoiseService.js';
import { mixAudioTracks, extractAudioFromVideo } from '../src/services/studio/audioStudioService.js';
import { exportStudioVideo } from '../src/services/studio/videoExportService.js';

test('AVINZ Studio Services Suite', async (t) => {
  const testDir = path.join(os.tmpdir(), `test_studio_${Date.now()}`);
  await fs.promises.mkdir(testDir, { recursive: true });

  // Generate a 2-second synthetic audio file using FFmpeg
  const audio1Path = path.join(testDir, 'synth_audio1.mp3');
  await new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=2',
      '-c:a', 'libmp3lame',
      audio1Path
    ], { windowsHide: true });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg error ${code}`)));
  });

  const audio2Path = path.join(testDir, 'synth_audio2.mp3');
  await new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=880:duration=2',
      '-c:a', 'libmp3lame',
      audio2Path
    ], { windowsHide: true });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg error ${code}`)));
  });

  // Generate a 2-second synthetic video file with audio
  const videoPath = path.join(testDir, 'synth_video.mp4');
  await new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, [
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-f', 'lavfi',
      '-i', 'sine=frequency=500:duration=2',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      videoPath
    ], { windowsHide: true });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg error ${code}`)));
  });

  await t.test('1. AI Background Noise Remover processes audio and outputs clean MP3', async () => {
    const res = await removeAudioNoise({
      filePath: audio1Path,
      outputDir: testDir,
      mode: 'voice_focus'
    });

    assert.strictEqual(res.type, 'audio');
    assert.strictEqual(res.mode, 'voice_focus');
    assert.ok(fs.existsSync(res.filePath));
    assert.ok(res.fileSize > 0);
  });

  await t.test('2. AI Background Noise Remover processes video and remuxes clean audio', async () => {
    const res = await removeAudioNoise({
      filePath: videoPath,
      outputDir: testDir,
      mode: 'strong'
    });

    assert.strictEqual(res.type, 'video');
    assert.ok(fs.existsSync(res.filePath));
    assert.strictEqual(res.fileName.endsWith('.mp4'), true);
  });

  await t.test('3. Audio Studio mixes multiple tracks with volume and offset', async () => {
    const res = await mixAudioTracks({
      tracks: [
        { filePath: audio1Path, volume: 1.0, startTime: 0 },
        { filePath: audio2Path, volume: 0.5, startTime: 0.5 }
      ],
      outputDir: testDir,
      outputFormat: 'mp3'
    });

    assert.strictEqual(res.tracksCount, 2);
    assert.ok(fs.existsSync(res.filePath));
    assert.ok(res.fileSize > 0);
  });

  await t.test('4. Audio Studio extracts audio track from video', async () => {
    const res = await extractAudioFromVideo({
      filePath: videoPath,
      outputDir: testDir,
      format: 'mp3'
    });

    assert.ok(fs.existsSync(res.filePath));
    assert.strictEqual(res.fileName.endsWith('.mp3'), true);
  });

  await t.test('5. Video Export Studio compiles timeline into final video', async () => {
    const res = await exportStudioVideo({
      timeline: {
        videoClips: [
          { filePath: videoPath, trimStart: 0, duration: 1, speed: 1 }
        ],
        audioClips: [
          { filePath: audio1Path, volume: 1 }
        ],
        effects: ['vignette', 'cinematic'],
        textOverlays: [
          { text: 'AVINZ STUDIO TEST', fontSize: 24, fontColor: 'white' }
        ]
      },
      outputDir: testDir,
      resolution: '480p',
      aspectRatio: '16:9',
      fps: 24,
      format: 'mp4'
    });

    assert.ok(fs.existsSync(res.filePath));
    assert.strictEqual(res.format, 'mp4');
    assert.ok(res.fileSize > 0);
  });

  // Cleanup temporary test files
  try {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  } catch (_) {}
});
