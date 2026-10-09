import type { Api, Bill, BillSummary, User } from './types';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include', // the session JWT lives in an httpOnly cookie
    headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  return body as T;
}

const json = (method: string, data?: unknown): RequestInit => ({ method, body: data === undefined ? undefined : JSON.stringify(data) });

export const httpApi: Api = {
  async me() {
    try {
      return await request<User>('/auth/me');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  login: (email, password) => request('/auth/login', json('POST', { email, password })),
  signup: (name, email, password) => request('/auth/signup', json('POST', { name, email, password })),
  logout: () => request('/auth/logout', json('POST')),
  updateName: (name) => request<User>('/account/name', json('PATCH', { name })),
  changeEmail: (email, currentPassword) => request<User>('/account/email', json('PATCH', { email, currentPassword })),
  changePassword: (currentPassword, newPassword) => request<User>('/account/password', json('PATCH', { currentPassword, newPassword })),
  deleteAccount: (currentPassword) => request('/account', json('DELETE', { currentPassword })),
  listBills: () => request<BillSummary[]>('/bills'),

  async uploadBill(file) {
    // 1. Create the bill and get a presigned URL. 2. Upload straight to S3. 3. Tell the API.
    const { id, uploadUrl } = await request<{ id: string; uploadUrl: string }>('/bills', json('POST', { filename: file.name }));
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } });
    if (!put.ok) throw new ApiError(put.status, 'The file could not be uploaded. Try again.');
    await request(`/bills/${id}/uploaded`, json('POST'));
    return id;
  },

  getBill: (id) => request<Bill>(`/bills/${id}`),
  retryBill: (id) => request(`/bills/${id}/uploaded`, json('POST')),
  submitReview: (id, payload) => request(`/bills/${id}/review`, json('PUT', payload)),
  requestLetter: (id) => request(`/bills/${id}/letter`, json('POST')),
  saveLetter: (id, text) => request(`/bills/${id}/letter`, json('PUT', { text })),
  deleteBill: (id) => request(`/bills/${id}`, { method: 'DELETE' }),
  renameBill: (id, name) => request(`/bills/${id}/name`, json('PATCH', { name })),

  async uploadEob(billId, file) {
    const { id, uploadUrl } = await request<{ id: string; uploadUrl: string }>(`/bills/${billId}/eobs`, json('POST', { filename: file.name }));
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } });
    if (!put.ok) throw new ApiError(put.status, 'The statement could not be uploaded. Try again.');
    await request(`/bills/${billId}/eobs/${id}/uploaded`, json('POST'));
  },
  retryEob: (billId, eobId) => request(`/bills/${billId}/eobs/${eobId}/uploaded`, json('POST')),
  deleteEob: (billId, eobId) => request(`/bills/${billId}/eobs/${eobId}`, { method: 'DELETE' }),
};
