/**
 * Pending Attachments Service
 *
 * Simple file-based storage for analyzed attachments.
 * Artie saves analysis to files, reads them back for follow-ups.
 */

import { logger } from '@coachartie/shared';
import * as fs from 'fs';
import * as path from 'path';

const ANALYSIS_DIR = '/tmp/artie-analysis';

// Ensure directory exists
if (!fs.existsSync(ANALYSIS_DIR)) {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
}

export interface PendingAttachment {
  buffer: Buffer;
  filename: string;
  content?: string;
}

// In-memory store for pending attachments to SEND (keyed by userId)
const pendingAttachments = new Map<string, PendingAttachment[]>();

/**
 * Get and clear pending attachments for a user
 */
export function getPendingAttachments(key: string): PendingAttachment[] {
  const attachments = pendingAttachments.get(key) || [];
  pendingAttachments.delete(key);
  return attachments;
}

/**
 * Add a pending attachment for a user
 */
export function addPendingAttachment(key: string, attachment: PendingAttachment): void {
  const existing = pendingAttachments.get(key) || [];
  existing.push(attachment);
  pendingAttachments.set(key, existing);
  logger.info(`📎 Queued pending attachment for ${key}: ${attachment.filename}`);
}

// ============================================
// FILE-BASED ANALYSIS STORAGE
// Simple: write to file, read from file
// ============================================

function getAnalysisPath(userId: string): string {
  // Sanitize userId for filesystem
  const safe = userId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(ANALYSIS_DIR, `${safe}.txt`);
}

function getAnalysisBufferPath(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(ANALYSIS_DIR, `${safe}.bin`);
}

/**
 * Save an analysis for a user (overwrites previous)
 */
export function saveAnalysis(
  userId: string,
  filename: string,
  summary: string,
  buffer?: Buffer
): void {
  const filePath = getAnalysisPath(userId);
  const content = `FILENAME: ${filename}
TIMESTAMP: ${new Date().toISOString()}
---
${summary}`;

  fs.writeFileSync(filePath, content, 'utf-8');
  logger.info(`📝 Saved analysis for ${userId}: ${filename}`);

  // Optionally save the binary buffer too
  if (buffer) {
    const bufferPath = getAnalysisBufferPath(userId);
    fs.writeFileSync(bufferPath, buffer);
    logger.info(`📦 Saved binary for ${userId}: ${buffer.length} bytes`);
  }
}

/**
 * Read the analysis for a user (returns null if none/expired)
 */
export function readAnalysis(userId: string): { filename: string; summary: string; age: number } | null {
  const filePath = getAnalysisPath(userId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const stat = fs.statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    const maxAge = 60 * 60 * 1000; // 1 hour

    if (ageMs > maxAge) {
      // Too old, clean up
      fs.unlinkSync(filePath);
      const bufferPath = getAnalysisBufferPath(userId);
      if (fs.existsSync(bufferPath)) fs.unlinkSync(bufferPath);
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const filenameLine = lines.find(l => l.startsWith('FILENAME:'));
    const filename = filenameLine ? filenameLine.replace('FILENAME:', '').trim() : 'unknown';

    // Everything after the --- line is the summary
    const separatorIndex = content.indexOf('---\n');
    const summary = separatorIndex >= 0 ? content.slice(separatorIndex + 4) : content;

    return { filename, summary, age: Math.round(ageMs / 60000) };
  } catch (err) {
    logger.warn(`Failed to read analysis for ${userId}:`, err);
    return null;
  }
}

/**
 * Check if user has a recent analysis
 */
export function hasAnalysis(userId: string): boolean {
  return readAnalysis(userId) !== null;
}

/**
 * Get the binary buffer if saved
 */
export function getAnalysisBuffer(userId: string): Buffer | null {
  const bufferPath = getAnalysisBufferPath(userId);
  if (!fs.existsSync(bufferPath)) return null;

  try {
    return fs.readFileSync(bufferPath);
  } catch {
    return null;
  }
}

/**
 * Clear analysis for a user
 */
export function clearAnalysis(userId: string): void {
  const filePath = getAnalysisPath(userId);
  const bufferPath = getAnalysisBufferPath(userId);

  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(bufferPath)) fs.unlinkSync(bufferPath);
}

// ============================================
// BACKWARDS COMPATIBILITY
// Old functions map to new file-based storage
// ============================================

export interface StoredAnalyzedFile {
  buffer: Buffer;
  filename: string;
  summary: string;
  fileType: string;
  mimeType?: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export function getFileType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const typeMap: Record<string, string> = {
    metro: 'metro', csv: 'csv', json: 'json', md: 'markdown',
    txt: 'text', log: 'text', ts: 'code', js: 'code', py: 'code',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
    pdf: 'document', xml: 'xml', html: 'html',
  };
  return typeMap[ext] || 'file';
}

export function storeAnalyzedFile(
  userId: string,
  filename: string,
  buffer: Buffer,
  summary: string,
  _fileType?: string,
  _mimeType?: string,
  _metadata?: Record<string, any>
): void {
  saveAnalysis(userId, filename, summary, buffer);
}

export function getStoredFile(userId: string, _fileType?: string): StoredAnalyzedFile | null {
  const analysis = readAnalysis(userId);
  if (!analysis) return null;

  const buffer = getAnalysisBuffer(userId) || Buffer.from('');
  return {
    buffer,
    filename: analysis.filename,
    summary: analysis.summary,
    fileType: getFileType(analysis.filename),
    timestamp: Date.now() - (analysis.age * 60000),
  };
}

export function hasStoredFile(userId: string, _fileType?: string): boolean {
  return hasAnalysis(userId);
}

export function clearStoredFile(userId: string, _fileType?: string): void {
  clearAnalysis(userId);
}

export function getAllStoredFiles(userId: string): StoredAnalyzedFile[] {
  const file = getStoredFile(userId);
  return file ? [file] : [];
}

// Metro-specific aliases
export function storeAnalyzedMetroFile(userId: string, filename: string, buffer: Buffer, summary: string): void {
  saveAnalysis(userId, filename, summary, buffer);
}

export function getStoredMetroFile(userId: string): { buffer: Buffer; filename: string; summary: string } | null {
  const analysis = readAnalysis(userId);
  if (!analysis) return null;
  return {
    buffer: getAnalysisBuffer(userId) || Buffer.from(''),
    filename: analysis.filename,
    summary: analysis.summary,
  };
}

export function hasStoredMetroFile(userId: string): boolean {
  return hasAnalysis(userId);
}

export function clearStoredMetroFile(userId: string): void {
  clearAnalysis(userId);
}
