import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { MovementHistoryPage } from './movement-history';

const manager = {
  id: 'u-mgr',
  email: 'manager01@erp.local',
  name: 'Manager One',
  role: 'MANAGER',
};

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MovementHistoryPage />
    </QueryClientProvider>,
  );
}

function list(items: unknown[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

const stores = list([
  { id: 's1', code: 'B01', name: 'Central' },
  { id: 's2', code: 'B02', name: 'Riverside' },
]);

const products = list([
  {
    id: 'p1',
    sku: 'SKU001',
    name: 'Water',
    category: 'Beverages',
    unit: 'pack',
    sellingPrice: '60.00',
    active: true,
  },
]);

function reference(extra: Record<string, unknown> = {}) {
  return {
    'GET /auth/me': { user: manager },
    'GET /stores': stores,
    'GET /products': products,
    ...extra,
  };
}

/** A movement-history row as the API returns it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    productId: 'p1',
    sku: 'SKU001',
    productName: 'Water',
    storeId: 's1',
    storeCode: 'B01',
    qtyChange: 5,
    balanceBefore: 10,
    balanceAfter: 15,
    type: 'GOODS_RECEIPT',
    sourceDocument: 'GR-000001',
    reason: null,
    actorId: 'u-staff',
    createdAt: '2026-01-15T03:00:00.000Z',
    ...overrides,
  };
}

function report(items: unknown[], storeId: string | null = null) {
  return { storeId, items, total: items.length, page: 1, pageSize: 20 };
}

describe('MovementHistoryPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders newest-first rows with the source document once the report resolves', async () => {
    mockApi(
      reference({
        'GET /reports/movement-history': report([
          row({ id: 'm2', type: 'SALE', sourceDocument: 'SAL-000002', qtyChange: -2 }),
          row(),
        ]),
      }),
    );

    renderPage();

    // Both movements render, each showing its source-document reference.
    expect(await screen.findByText('SAL-000002')).toBeInTheDocument();
    expect(screen.getByText('GR-000001')).toBeInTheDocument();
  });

  it('shows a clear Thai empty-state when nothing matches the filters', async () => {
    mockApi(reference({ 'GET /reports/movement-history': report([]) }));

    renderPage();

    expect(
      await screen.findByText(
        'ไม่พบความเคลื่อนไหวของสต็อกที่ตรงกับตัวกรองที่เลือก กรุณาปรับตัวกรองหรือช่วงวันที่',
      ),
    ).toBeInTheDocument();
  });

  it('sends the store, type and date-range filters to the movement-history endpoint', async () => {
    const fetch = mockApi(reference({ 'GET /reports/movement-history': report([], 's1') }));

    renderPage();

    await screen.findByRole('option', { name: 'B01 — Central' });
    fireEvent.change(screen.getByLabelText('สาขา'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('ประเภทความเคลื่อนไหว'), {
      target: { value: 'SALE' },
    });
    fireEvent.change(screen.getByLabelText('ตั้งแต่วันที่'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('ถึงวันที่'), { target: { value: '2026-01-31' } });

    await waitFor(() => {
      const calls = fetch.mock.calls.filter(
        ([r]) => new URL(r.url).pathname === '/api/reports/movement-history',
      );
      expect(calls.length).toBeGreaterThan(0);
      const url = new URL(calls[calls.length - 1]![0].url);
      expect(url.searchParams.get('storeId')).toBe('s1');
      expect(url.searchParams.get('type')).toBe('SALE');
      expect(url.searchParams.get('from')).toBe('2026-01-01');
      expect(url.searchParams.get('to')).toBe('2026-01-31');
    });
  });

  it('shows the Thai error state when the report request fails', async () => {
    mockApi(
      reference({
        'GET /reports/movement-history': new Response('boom', { status: 500 }),
      }),
    );

    renderPage();

    // The query client retries a failed read once before surfacing the error, so allow for it.
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'เกิดข้อผิดพลาด',
    );
  });
});
