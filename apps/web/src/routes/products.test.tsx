import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_LIST_MESSAGE } from '@erp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { conflict, mockApi } from '@/test/mock-api';
import { ProductsPage } from './products';

const admin = { id: '1', email: 'admin@erp.local', name: 'Admin User', role: 'ADMIN' };

function renderProducts() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ProductsPage />
    </QueryClientProvider>,
  );
}

function list(items: unknown[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

const stores = list([
  {
    id: 's1',
    code: 'B01',
    name: 'Central',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]);

const water = {
  id: 'p1',
  sku: 'SKU001',
  name: 'Drinking water pack of 6',
  category: 'Beverages',
  unit: 'pack',
  sellingPrice: '60.00',
  active: true,
  skuLocked: false,
  thresholds: [{ storeId: 's1', threshold: 3 }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('ProductsPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state before the list resolves', () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /products': list([]), 'GET /stores': stores });

    renderProducts();

    expect(screen.getByText('กำลังโหลด…')).toBeInTheDocument();
  });

  it('renders products once the list resolves', async () => {
    mockApi({
      'GET /auth/me': { user: admin },
      'GET /products': list([water]),
      'GET /stores': stores,
    });

    renderProducts();

    expect(await screen.findByText('Drinking water pack of 6')).toBeInTheDocument();
    expect(screen.getByText('SKU001')).toBeInTheDocument();
  });

  it('shows a Thai empty state when there are no products', async () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /products': list([]), 'GET /stores': stores });

    renderProducts();

    expect(await screen.findByText(EMPTY_LIST_MESSAGE)).toBeInTheDocument();
  });

  it('creates a product and sends the typed payload', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: admin },
      'GET /products': list([]),
      'GET /stores': stores,
      'POST /products': water,
    });

    renderProducts();

    fireEvent.change(await screen.findByLabelText('รหัสสินค้า (SKU)'), {
      target: { value: 'SKU001' },
    });
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), {
      target: { value: 'Drinking water pack of 6' },
    });
    fireEvent.change(screen.getByLabelText('หมวดหมู่'), { target: { value: 'Beverages' } });
    fireEvent.change(screen.getByLabelText('หน่วย'), { target: { value: 'pack' } });
    fireEvent.change(screen.getByLabelText('ราคาขาย'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('จุดสั่งซื้อ B01'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    await waitFor(() => {
      expect(fetch.mock.calls.find(([r]) => r.method === 'POST')).toBeTruthy();
    });
    const post = fetch.mock.calls.find(([r]) => r.method === 'POST')![0];
    await expect(post.json()).resolves.toMatchObject({
      sku: 'SKU001',
      name: 'Drinking water pack of 6',
      category: 'Beverages',
      unit: 'pack',
      sellingPrice: 60,
      thresholds: [{ storeId: 's1', threshold: 3 }],
    });
  });

  it('shows the actionable Thai message when the SKU is already taken', async () => {
    mockApi({
      'GET /auth/me': { user: admin },
      'GET /products': list([]),
      'GET /stores': stores,
      'POST /products': conflict(
        'รหัส "SKU001" ถูกใช้งานแล้ว กรุณาแก้ไขรหัสให้ไม่ซ้ำกับรายการที่มีอยู่',
      ),
    });

    renderProducts();

    fireEvent.change(await screen.findByLabelText('รหัสสินค้า (SKU)'), {
      target: { value: 'SKU001' },
    });
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'Water' } });
    fireEvent.change(screen.getByLabelText('หมวดหมู่'), { target: { value: 'Beverages' } });
    fireEvent.change(screen.getByLabelText('หน่วย'), { target: { value: 'pack' } });
    fireEvent.change(screen.getByLabelText('ราคาขาย'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ถูกใช้งานแล้ว');
  });

  it('edits an existing product', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: admin },
      'GET /products': list([water]),
      'GET /stores': stores,
      'PUT /products/p1': { ...water, name: 'Water 6-pack' },
    });

    renderProducts();

    fireEvent.click(await screen.findByRole('button', { name: 'แก้ไข SKU001' }));
    const nameInput = screen.getByLabelText('ชื่อสินค้า');
    expect(nameInput).toHaveValue('Drinking water pack of 6');
    fireEvent.change(nameInput, { target: { value: 'Water 6-pack' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

    await waitFor(() => {
      expect(fetch.mock.calls.find(([r]) => r.method === 'PUT')).toBeTruthy();
    });
    const put = fetch.mock.calls.find(([r]) => r.method === 'PUT')![0];
    expect(new URL(put.url).pathname).toBe('/api/products/p1');
    await expect(put.json()).resolves.toMatchObject({ name: 'Water 6-pack', sku: 'SKU001' });
  });
});
