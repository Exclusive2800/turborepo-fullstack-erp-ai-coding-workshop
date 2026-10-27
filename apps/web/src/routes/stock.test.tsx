import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_LIST_MESSAGE } from '@erp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { StockPage } from './stock';

const staff = {
  id: '1',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STAFF',
  assignedStoreId: 's1',
};

function renderStock() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <StockPage />
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
  productId: 'p1',
  sku: 'SKU001',
  name: 'Drinking water pack of 6',
  unit: 'pack',
  storeId: 's1',
  storeCode: 'B01',
  quantity: 10,
  reorderThreshold: 3,
  lowStock: false,
};

const detergent = {
  productId: 'p3',
  sku: 'SKU003',
  name: 'Laundry detergent',
  unit: 'bag',
  storeId: 's1',
  storeCode: 'B01',
  quantity: 0,
  reorderThreshold: 3,
  lowStock: true,
};

describe('StockPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state before the stock list resolves', () => {
    mockApi({ 'GET /auth/me': { user: staff }, 'GET /stock': list([]), 'GET /stores': stores });

    renderStock();

    expect(screen.getByText('กำลังโหลด…')).toBeInTheDocument();
  });

  it('renders quantity, unit and threshold for each stock row', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /stock': list([water]),
      'GET /stores': stores,
    });

    renderStock();

    expect(await screen.findByText('Drinking water pack of 6')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /SKU001/ });
    expect(row).toHaveTextContent('10');
    expect(row).toHaveTextContent('pack');
    expect(row).toHaveTextContent('3');
  });

  it('flags a low-stock row and keeps the zero-stock product visible', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /stock': list([detergent]),
      'GET /stores': stores,
    });

    renderStock();

    const row = await screen.findByRole('row', { name: /SKU003/ });
    expect(row).toHaveTextContent('0');
    expect(row).toHaveTextContent('ใกล้หมด');
  });

  it('shows a Thai empty state when nothing matches', async () => {
    mockApi({ 'GET /auth/me': { user: staff }, 'GET /stock': list([]), 'GET /stores': stores });

    renderStock();

    expect(await screen.findByText(EMPTY_LIST_MESSAGE)).toBeInTheDocument();
  });

  it('passes the search term to the stock query', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: staff },
      'GET /stock': list([water]),
      'GET /stores': stores,
    });

    renderStock();

    await screen.findByText('Drinking water pack of 6');
    fireEvent.change(screen.getByLabelText('ค้นหาสินค้า'), { target: { value: 'SKU001' } });

    await waitFor(() => {
      const stockCall = fetch.mock.calls.find(
        ([r]) => new URL(r.url).pathname === '/api/stock' && r.url.includes('SKU001'),
      );
      expect(stockCall).toBeTruthy();
    });
  });
});
