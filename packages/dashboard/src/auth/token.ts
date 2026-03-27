export const ADMIN_TOKEN_STORAGE_KEY = 'admin_token';

export function getStoredAdminToken(): string {
  try {
    return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredAdminToken(token: string): void {
  try {
    const trimmed = token.trim();
    if (trimmed) {
      localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  } catch {
    // localStorage 저장 실패 무시
  }
}
