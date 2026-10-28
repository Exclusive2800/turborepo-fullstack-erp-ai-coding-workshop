import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_LIST_MESSAGE, PO_DUPLICATE_SKU_MESSAGE } from '@erp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { conflict, mockApi } from '@/test/mock-api';
import { PurchaseOrdersPage } from './purchase-orders';

const buyer = { id: '1', email: 'buyer01@erp.local', name: 'Buyer One', role: 'PURCHASING' };
const staff = { id: '2', email: 'staff_b01@erp.local', name: 'Staff B01', role: 'STAFF' };

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <PurchaseOrdersPage />
    </QueryClientProvider>,
  );
}

function list(items: unknown[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

const suppliers = list([
  {
    id: 'sup1',
    code: 'SUP01',
    name: 'SupplyOne',
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]);

const stores = list([
  {
    id: 's1',
    code: 'B01',
    name: 'Central',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]);

const products = list([
  {
    id: 'p1',
    sku: 'SKU001',
    name: 'Drinking water pack of 6',
    category: 'Beverages',
    unit: 'pack',
    sellingPrice: '60.00',
    active: true,
    skuLocked: false,
    thresholds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'p2',
    sku: 'SKU002',
    name: 'Tissue paper',
    category: 'Household',
    unit: 'pack',
    sellingPrice: '35.00',
    active: true,
    skuLocked: false,
    thresholds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]);

const draftOrder = {
  id: 'po1',
  number: 'PO-000001',
  status: 'DRAFT',
  supplierId: 'sup1',
  storeId: 's1',
  expectedReceiptDate: '2026-02-01T00:00:00.000Z',
  total: '900.00',
  lines: [
    {
      id: 'l1',
      productId: 'p1',
      sku: 'SKU001',
      productName: 'Drinking water pack of 6',
      quantity: 20,
      unitPrice: '45.00',
      lineTotal: '900.00',
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function referenceData(extra: Record<string, unknown> = {}) {
  return {
    'GET /auth/me': { user: buyer },
    'GET /suppliers': suppliers,
    'GET /stores': stores,
    'GET /products': products,
    'GET /purchase-orders': list([]),
    ...extra,
  };
}

describe('PurchaseOrdersPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state before the order list resolves', () => {
    mockApi(referenceData());

    renderPage();

    expect(screen.getByText('กำลังโหลด…')).toBeInTheDocument();
  });

  it('shows a Thai empty state when there are no orders', async () => {
    mockApi(referenceData());

    renderPage();

    expect(await screen.findByText(EMPTY_LIST_MESSAGE)).toBeInTheDocument();
  });

  it('renders existing orders once the list resolves', async () => {
    mockApi(referenceData({ 'GET /purchase-orders': list([draftOrder]) }));

    renderPage();

    expect(await screen.findByText('PO-000001')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
  });

  it('lets a purchasing user add lines and sends the typed payload', async () => {
    const fetch = mockApi(referenceData({ 'POST /purchase-orders': draftOrder }));

    renderPage();

    // Wait for the reference-data options to populate before selecting them.
    await screen.findByRole('option', { name: 'SUP01 — SupplyOne' });
    fireEvent.change(screen.getByLabelText('ผู้จัดจำหน่าย'), { target: { value: 'sup1' } });
    fireEvent.change(screen.getByLabelText('สาขาปลายทาง'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('วันที่คาดว่าจะรับสินค้า'), {
      target: { value: '2026-02-01' },
    });

    // First line.
    fireEvent.change(screen.getByLabelText('สินค้า 1'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('จำนวน 1'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย 1'), { target: { value: '45' } });

    // Add a second line.
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มรายการ' }));
    fireEvent.change(screen.getByLabelText('สินค้า 2'), { target: { value: 'p2' } });
    fireEvent.change(screen.getByLabelText('จำนวน 2'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย 2'), { target: { value: '35' } });

    fireEvent.click(screen.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }));

    await waitFor(() => {
      expect(fetch.mock.calls.find(([r]) => r.method === 'POST')).toBeTruthy();
    });
    const post = fetch.mock.calls.find(([r]) => r.method === 'POST')![0];
    expect(new URL(post.url).pathname).toBe('/api/purchase-orders');
    await expect(post.json()).resolves.toMatchObject({
      supplierId: 'sup1',
      storeId: 's1',
      lines: [
        { productId: 'p1', quantity: 20, unitPrice: 45 },
        { productId: 'p2', quantity: 5, unitPrice: 35 },
      ],
    });
  });

  it('removes an added line', async () => {
    mockApi(referenceData());

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'เพิ่มรายการ' }));
    expect(screen.getByLabelText('สินค้า 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ลบรายการ 2' }));
    expect(screen.queryByLabelText('สินค้า 2')).not.toBeInTheDocument();
  });

  it('shows the actionable Thai message when the API rejects a duplicate SKU', async () => {
    mockApi(referenceData({ 'POST /purchase-orders': conflict(PO_DUPLICATE_SKU_MESSAGE) }));

    renderPage();

    await screen.findByRole('option', { name: 'SUP01 — SupplyOne' });
    fireEvent.change(screen.getByLabelText('ผู้จัดจำหน่าย'), { target: { value: 'sup1' } });
    fireEvent.change(screen.getByLabelText('สาขาปลายทาง'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('วันที่คาดว่าจะรับสินค้า'), {
      target: { value: '2026-02-01' },
    });
    fireEvent.change(screen.getByLabelText('สินค้า 1'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('จำนวน 1'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย 1'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('สินค้าซ้ำ');
  });

  it('hides the create form from a non-purchasing user', async () => {
    mockApi(referenceData({ 'GET /auth/me': { user: staff } }));

    renderPage();

    // The list still renders, but there is no create form for a store employee.
    await screen.findByText(EMPTY_LIST_MESSAGE);
    expect(screen.queryByLabelText('ผู้จัดจำหน่าย')).not.toBeInTheDocument();
  });
});
