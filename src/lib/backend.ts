import type { SessionHistoryRecord } from '../types/contracts';

export function getServerBaseUrl(port: number | null) {
  return port ? `http://127.0.0.1:${port}` : null;
}

function authHeaders(token: string | null) {
  return token ? { 'X-Wingman-Token': token } : {};
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
    throw new Error((await response.text()) || 'Resume upload failed.');
  }

  return (await response.json()) as { resume_text: string };
}

export async function loadHistory(port: number, token: string | null) {
  const response = await fetch(`${getServerBaseUrl(port)}/history`, {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error((await response.text()) || 'Failed to load session history.');
  }

  return (await response.json()) as { sessions: SessionHistoryRecord[] };
}
