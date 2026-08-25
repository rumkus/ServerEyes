const API_URL = 'https://servereyes.app';

export async function apiRequest(path: string, options: any = {}, token: string | null = null) {
  const headers: any = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await response.json();
  return { ok: response.ok, data };
}

export const getMachines = (token: string) => apiRequest('/api/machines', {}, token);

export const addMachine = (token: string, name: string) =>
  apiRequest('/api/machines', { method: 'POST', body: JSON.stringify({ machine_name: name }) }, token);

export const deleteMachine = (token: string, id: number) =>
  apiRequest(`/api/machines/${id}`, { method: 'DELETE' }, token);

export const clerkLogin = (clerkId: string, email: string) =>
  apiRequest('/api/auth/clerk-login', {
    method: 'POST',
    body: JSON.stringify({ clerk_id: clerkId, email }),
  });
