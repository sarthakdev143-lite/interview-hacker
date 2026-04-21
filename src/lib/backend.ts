import type { SessionHistoryRecord } from '../types/contracts';

export function getServerBaseUrl(port: number | null) {
  return port ? `http://127.0.0.1:${port}` : null;
}

export async function uploadResume(port: number, file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${getServerBaseUrl(port)}/resume/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error((await response.text()) || 'Resume upload failed.');
  }

  return (await response.json()) as { resume_text: string };
}

export async function loadHistory(port: number) {
  const response = await fetch(`${getServerBaseUrl(port)}/history`);
  if (!response.ok) {
    throw new Error((await response.text()) || 'Failed to load session history.');
  }

  return (await response.json()) as { sessions: SessionHistoryRecord[] };
}
