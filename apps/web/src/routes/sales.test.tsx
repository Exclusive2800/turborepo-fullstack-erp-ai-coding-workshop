import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_LIST_MESSAGE, PRODUCT_INACTIVE_MESSAGE } from '@erp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { conflict, mockApi } from '@/test/mock-api';
import { SalesPage } from './sales';

const staff = { id: '2', email: 'staff_b01@erp.local', name: 'Staff B01', role: 'STAFF' };
const buyer = { id: '1', email: 'buyer01@erp.local', name: 'Buyer One', role: 'PURCHASING' };

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <SalesPage />
    </QueryClientProvider>,
  );
}

function list(items: unknown[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

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
  {
    id: 'p3',
    sku: 'SKU099',
    name: 'Discontinued item',
    category: 'Household',
    unit: 'pack',
    sellingPrice: '10.00',
    active: false,
    skuLocked: false,
    thresholds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]);

const draftSale = {
  id: 'sale1',
  storeId: 's1',
  status: 'DRAFT',
  total: '120.00',
  lines: [
    {
      id: 'l1',
      productId: 'p1',
      sku: 'SKU001',
      productName: 'Drinking water pack of 6',
      quantity: 2,
      unitPrice: '60.00',
      lineTotal: '120.00',
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function referenceData(extra: Record<string, unknown> = {}) {
  return {
    'GET /auth/me': { user: staff },
    'GET /products': products,
    'GET /sales': list([]),
    ...extra,
  };
}

describe('SalesPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state before the sales list resolves', () => {
    mockApi(referenceData());

    renderPage();

    expect(screen.getByText('กำลังโหลด…')).toBeInTheDocument();
  });

  it('shows a Thai empty state when there are no sales', async () => {
    mockApi(referenceData());

    renderPage();

    expect(await screen.findByText(EMPTY_LIST_MESSAGE)).toBeInTheDocument();
  });

  it('renders existing sales once the list resolves', async () => {
    mockApi(referenceData({ 'GET /sales': list([draftSale]) }));

    renderPage();

    expect(await screen.findByText('sale1')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
  });

  it('keeps deactivated products out of the picker (only active products are sellable)', async () => {
    mockApi(referenceData());

    renderPage();

    await screen.findByRole('option', { name: /SKU001/ });
    expect(screen.getByRole('option', { name: /SKU001/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /SKU002/ })).toBeInTheDocument();
    // SKU099 is inactive — it must not appear as a sellable option.
    expect(screen.queryByRole('option', { name: /SKU099/ })).not.toBeInTheDocument();
  });

  it('shows the current selling price for a chosen product and sends only product + quantity (no price override)', async () => {
    const fetch = mockApi(referenceData({ 'POST /sales': draftSale }));

    renderPage();

    await screen.findByRole('option', { name: /SKU001/ });
    fireEvent.change(screen.getByLabelText('สินค้า 1'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('จำนวน 1'), { target: { value: '2' } });

    // The current selling price is shown read-only; the user cannot override it.
    expect(screen.getByText('฿60.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'บันทึกรายการขาย' }));

    await waitFor(() => {
      expect(fetch.mock.calls.find(([r]) => r.method === 'POST')).toBeTruthy();
    });
    const post = fetch.mock.calls.find(([r]) => r.method === 'POST')![0];
    expect(new URL(post.url).pathname).toBe('/api/sales');
    const body = await post.json();
    expect(body).toEqual({ lines: [{ productId: 'p1', quantity: 2 }] });
    // The payload carries no price and no store — both are controlled server-side.
    expect(JSON.stringify(body)).not.toContain('unitPrice');
    expect(JSON.stringify(body)).not.toContain('storeId');
  });

  it('adds and removes lines', async () => {
    mockApi(referenceData());

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'เพิ่มรายการ' }));
    expect(screen.getByLabelText('สินค้า 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ลบรายการ 2' }));
    expect(screen.queryByLabelText('สินค้า 2')).not.toBeInTheDocument();
  });

  it('shows the actionable Thai message when the API rejects an inactive product', async () => {
    mockApi(referenceData({ 'POST /sales': conflict(PRODUCT_INACTIVE_MESSAGE) }));

    renderPage();

    await screen.findByRole('option', { name: /SKU001/ });
    fireEvent.change(screen.getByLabelText('สินค้า 1'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('จำนวน 1'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกรายการขาย' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ปิดการใช้งาน');
  });

  it('hides the create form from a non-staff user', async () => {
    mockApi(referenceData({ 'GET /auth/me': { user: buyer } }));

    renderPage();

    // The list still renders, but there is no create form for a non-store-employee.
    await screen.findByText(EMPTY_LIST_MESSAGE);
    expect(screen.queryByLabelText('สินค้า 1')).not.toBeInTheDocument();
  });
});
