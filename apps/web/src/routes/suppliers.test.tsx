import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_LIST_MESSAGE } from '@erp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { conflict, mockApi } from '@/test/mock-api';
import { SuppliersPage } from './suppliers';

const admin = { id: '1', email: 'admin@erp.local', name: 'Admin User', role: 'ADMIN' };

function renderSuppliers() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <SuppliersPage />
    </QueryClientProvider>,
  );
}

function supplierList(items: unknown[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

const supplyOne = {
  id: 'sup1',
  code: 'SUP01',
  name: 'SupplyOne',
  contactName: 'Somchai',
  contactEmail: 'somchai@supplyone.co.th',
  contactPhone: '02-123-4567',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('SuppliersPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state before the list resolves', () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /suppliers': supplierList([]) });

    renderSuppliers();

    expect(screen.getByText('กำลังโหลด…')).toBeInTheDocument();
  });

  it('renders suppliers once the list resolves', async () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /suppliers': supplierList([supplyOne]) });

    renderSuppliers();

    expect(await screen.findByText('SupplyOne')).toBeInTheDocument();
    expect(screen.getByText('SUP01')).toBeInTheDocument();
  });

  it('shows a Thai empty state when there are no suppliers', async () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /suppliers': supplierList([]) });

    renderSuppliers();

    expect(await screen.findByText(EMPTY_LIST_MESSAGE)).toBeInTheDocument();
  });

  it('creates a supplier', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: admin },
      'GET /suppliers': supplierList([]),
      'POST /suppliers': supplyOne,
    });

    renderSuppliers();

    fireEvent.change(await screen.findByLabelText('รหัสผู้จัดจำหน่าย'), {
      target: { value: 'SUP01' },
    });
    fireEvent.change(screen.getByLabelText('ชื่อผู้จัดจำหน่าย'), {
      target: { value: 'SupplyOne' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    await waitFor(() => {
      expect(fetch.mock.calls.find(([request]) => request.method === 'POST')).toBeTruthy();
    });
    const post = fetch.mock.calls.find(([request]) => request.method === 'POST')![0];
    await expect(post.json()).resolves.toMatchObject({ code: 'SUP01', name: 'SupplyOne' });
  });

  it('shows the actionable Thai message when the code is already taken', async () => {
    mockApi({
      'GET /auth/me': { user: admin },
      'GET /suppliers': supplierList([]),
      'POST /suppliers': conflict(
        'รหัส "SUP01" ถูกใช้งานแล้ว กรุณาแก้ไขรหัสให้ไม่ซ้ำกับรายการที่มีอยู่',
      ),
    });

    renderSuppliers();

    fireEvent.change(await screen.findByLabelText('รหัสผู้จัดจำหน่าย'), {
      target: { value: 'SUP01' },
    });
    fireEvent.change(screen.getByLabelText('ชื่อผู้จัดจำหน่าย'), {
      target: { value: 'SupplyOne' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ถูกใช้งานแล้ว');
  });

  it('edits an existing supplier', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: admin },
      'GET /suppliers': supplierList([supplyOne]),
      'PUT /suppliers/sup1': { ...supplyOne, name: 'SupplyOne Co' },
    });

    renderSuppliers();

    fireEvent.click(await screen.findByRole('button', { name: 'แก้ไข SUP01' }));
    const nameInput = screen.getByLabelText('ชื่อผู้จัดจำหน่าย');
    expect(nameInput).toHaveValue('SupplyOne');
    fireEvent.change(nameInput, { target: { value: 'SupplyOne Co' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    await waitFor(() => {
      expect(fetch.mock.calls.find(([request]) => request.method === 'PUT')).toBeTruthy();
    });
    const put = fetch.mock.calls.find(([request]) => request.method === 'PUT')![0];
    expect(new URL(put.url).pathname).toBe('/api/suppliers/sup1');
    await expect(put.json()).resolves.toMatchObject({ name: 'SupplyOne Co' });
  });
});
