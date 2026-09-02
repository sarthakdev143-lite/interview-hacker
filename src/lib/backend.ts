// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

import type { SessionHistoryRecord } from '../types/contracts';

export function getServerBaseUrl(port: number | null) {
  return port ? `http://127.0.0.1:${port}` : null;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { 'X-Wingman-Token': token } : {};
}

/**
 * The sidecar reports failures as `{"error": "..."}`. Reading the raw body
 * instead surfaced that JSON verbatim in the UI, so a user hitting the upload
 * size limit saw `{"error": "File is larger than the 10MB limit."}` rather than
 * the sentence inside it.
 */
async function readError(response: Response, fallback: string) {
  const body = await response.text().catch(() => '');
  if (!body) {
    return `${fallback} (HTTP ${response.status})`;
  }

  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }

  return body;
}

export async function uploadResume(port: number, token: string | null, file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${getServerBaseUrl(port)}/resume/upload`, {
    method: 'POST',
    headers: authHeaders(token),
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readError(response, 'Resume upload failed.'));
  }

  return (await response.json()) as { resume_text: string };
}

/**
 * Fire a manual question. The tokens come back on the shared `/answer/stream`
 * SSE connection, so this only needs to report whether the request was accepted.
 */
export async function submitManualAnswer(
  port: number,
  token: string | null,
  prompt: string,
) {
  const response = await fetch(`${getServerBaseUrl(port)}/answer/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    throw new Error(await readError(response, 'Manual answer request failed.'));
  }
}

export interface HistoryPage {
  sessions: SessionHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
}

export async function loadHistory(
  port: number,
  token: string | null,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<HistoryPage> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const response = await fetch(`${getServerBaseUrl(port)}/history?${query}`, {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load session history.'));
  }

  return (await response.json()) as HistoryPage;
}

export async function deleteHistoryEntry(
  port: number,
  token: string | null,
  sessionId: string,
) {
  const response = await fetch(
    `${getServerBaseUrl(port)}/history/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', headers: authHeaders(token) },
  );
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to delete that session.'));
  }

  return (await response.json()) as { deleted: number };
}

export async function clearHistory(port: number, token: string | null) {
  const response = await fetch(`${getServerBaseUrl(port)}/history`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to clear history.'));
  }

  return (await response.json()) as { deleted: number };
}
