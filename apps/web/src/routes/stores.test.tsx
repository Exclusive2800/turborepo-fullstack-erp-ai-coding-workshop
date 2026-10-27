import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_LIST_MESSAGE } from '@erp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { conflict, mockApi } from '@/test/mock-api';
import { StoresPage } from './stores';

const admin = { id: '1', email: 'admin@erp.local', name: 'Admin User', role: 'ADMIN' };

function renderStores() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <StoresPage />
    </QueryClientProvider>,
  );
}

function storeList(items: unknown[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

const central = {
  id: 's1',
  code: 'B01',
  name: 'Central',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('StoresPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state before the list resolves', () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /stores': storeList([]) });

    renderStores();

    expect(screen.getByText('กำลังโหลด…')).toBeInTheDocument();
  });

  it('renders stores once the list resolves', async () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /stores': storeList([central]) });

    renderStores();

    expect(await screen.findByText('Central')).toBeInTheDocument();
    expect(screen.getByText('B01')).toBeInTheDocument();
  });

  it('shows a Thai empty state when there are no stores', async () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /stores': storeList([]) });

    renderStores();

    expect(await screen.findByText(EMPTY_LIST_MESSAGE)).toBeInTheDocument();
  });

  it('creates a store and shows it in the list', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: admin },
      'GET /stores': storeList([]),
      'POST /stores': central,
    });

    renderStores();

    fireEvent.change(await screen.findByLabelText('รหัสสาขา'), { target: { value: 'B01' } });
    fireEvent.change(screen.getByLabelText('ชื่อสาขา'), { target: { value: 'Central' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    await waitFor(() => {
      const post = fetch.mock.calls.find(([request]) => request.method === 'POST');
      expect(post).toBeTruthy();
    });
    const post = fetch.mock.calls.find(([request]) => request.method === 'POST')![0];
    await expect(post.json()).resolves.toEqual({ code: 'B01', name: 'Central' });
  });

  it('shows the actionable Thai message when the code is already taken', async () => {
    mockApi({
      'GET /auth/me': { user: admin },
      'GET /stores': storeList([]),
      'POST /stores': conflict(
        'รหัส "B01" ถูกใช้งานแล้ว กรุณาแก้ไขรหัสให้ไม่ซ้ำกับรายการที่มีอยู่',
      ),
    });

    renderStores();

    fireEvent.change(await screen.findByLabelText('รหัสสาขา'), { target: { value: 'B01' } });
    fireEvent.change(screen.getByLabelText('ชื่อสาขา'), { target: { value: 'Central' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ถูกใช้งานแล้ว');
  });

  it('edits an existing store', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: admin },
      'GET /stores': storeList([central]),
      'PUT /stores/s1': { ...central, name: 'Central Plaza' },
    });

    renderStores();

    fireEvent.click(await screen.findByRole('button', { name: 'แก้ไข B01' }));
    const nameInput = screen.getByLabelText('ชื่อสาขา');
    expect(nameInput).toHaveValue('Central');
    fireEvent.change(nameInput, { target: { value: 'Central Plaza' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    await waitFor(() => {
      expect(fetch.mock.calls.find(([request]) => request.method === 'PUT')).toBeTruthy();
    });
    const put = fetch.mock.calls.find(([request]) => request.method === 'PUT')![0];
    expect(new URL(put.url).pathname).toBe('/api/stores/s1');
    await expect(put.json()).resolves.toMatchObject({ code: 'B01', name: 'Central Plaza' });
  });
});
