export const DEFAULT_BASE_URL = 'https://chatgpt.com';

export const ENDPOINTS = {
  SESSION: '/api/auth/session',
  CONVERSATIONS: '/backend-api/conversations',
  CONVERSATION: (id: string) => `/backend-api/conversation/${id}`,
  PROJECTS_SIDEBAR: '/backend-api/gizmos/snorlax/sidebar',
  PROJECT_CONVERSATIONS: (gizmoId: string) => `/backend-api/gizmos/${gizmoId}/conversations`,
  FILE_DOWNLOAD: (fileId: string) => `/backend-api/files/download/${fileId}`,
} as const;

/** CHATGPT_BASE_URL may point at a local mock server (tests only); anything else uses chatgpt.com. */
export function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit.replace(/\/+$/, '');
  const fromEnv = process.env.CHATGPT_BASE_URL;
  if (fromEnv && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(fromEnv)) {
    return fromEnv.replace(/\/+$/, '');
  }
  return DEFAULT_BASE_URL;
}
