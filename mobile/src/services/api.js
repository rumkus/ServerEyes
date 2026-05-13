const API_URL = 'https://servereyes-production.up.railway.app';

export async function apiRequest(path, options = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

export function getMachines(token) {
  return apiRequest('/api/machines', {}, token);
}

export function addMachine(token, machineName) {
  return apiRequest('/api/machines', {
    method: 'POST',
    body: JSON.stringify({ machine_name: machineName }),
  }, token);
}

export function deleteMachine(token, machineId) {
  return apiRequest(`/api/machines/${machineId}`, { method: 'DELETE' }, token);
}

export function getNotifications(token) {
  return apiRequest('/api/notifications', {}, token);
}

export function getMachineHistory(token, machineId) {
  return apiRequest(`/api/machines/${machineId}/history`, {}, token);
}
