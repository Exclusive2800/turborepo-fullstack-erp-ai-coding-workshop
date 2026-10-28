import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { StockReportsPage } from './stock-reports';

const staff = {
  id: '4',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STAFF',
};

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <StockReportsPage />
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

function reference(extra: Record<string, unknown> = {}) {
  return {
    'GET /auth/me': { user: staff },
    'GET /stores': stores,
    ...extra,
  };
}

/** A stock-report row as the API returns it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    productId: 'p3',
    sku: 'SKU003',
    name: 'Laundry detergent',
    unit: 'bag',
    storeId: 's1',
    storeCode: 'B01',
    quantity: 0,
    reorderThreshold: 3,
    lowStock: true,
    ...overrides,
  };
}

describe('StockReportsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the stock-on-hand rows once the report resolves, keeping a zero-stock match visible', async () => {
    mockApi(
      reference({
        'GET /reports/stock-on-hand': {
          storeId: 's1',
          items: [
            row({ productId: 'p1', sku: 'SKU001', name: 'Water', quantity: 10, lowStock: false }),
            row(),
          ],
          total: 2,
        },
      }),
    );

    renderPage();

    // Both rows render, including the zero-stock SKU003 — it is not hidden for having balance 0.
    expect(await screen.findByText('SKU001')).toBeInTheDocument();
    const sku003 = await screen.findByText('SKU003');
    expect(sku003).toBeInTheDocument();
    // The zero-stock low-stock row is marked near-empty.
    expect(screen.getByText('ใกล้หมด')).toBeInTheDocument();
  });

  it('shows a clear Thai empty-state when the stock-on-hand report matches nothing', async () => {
    mockApi(
      reference({
        'GET /reports/stock-on-hand': { storeId: 's1', items: [], total: 0 },
      }),
    );

    renderPage();

    expect(
      await screen.findByText(
        'ไม่พบสินค้าที่ตรงกับสาขาและคำค้นหาที่เลือก กรุณาปรับคำค้นหาหรือเลือกสาขาอื่น',
      ),
    ).toBeInTheDocument();
  });

  it('switches to the low-stock report for a store and lists only low-stock rows', async () => {
    const fetch = mockApi(
      reference({
        'GET /reports/stock-on-hand': { storeId: 's1', items: [row()], total: 1 },
        'GET /reports/low-stock': { storeId: 's1', items: [row()], total: 1 },
      }),
    );

    renderPage();

    // Wait for the store options to load, choose a store, then switch to the low-stock report.
    await screen.findByRole('option', { name: 'B01 — Central' });
    fireEvent.change(screen.getByLabelText('สาขา'), { target: { value: 's1' } });
    fireEvent.click(screen.getByLabelText('สินค้าใกล้หมด'));

    await waitFor(() => {
      const calls = fetch.mock.calls.filter(
        ([r]) => new URL(r.url).pathname === '/api/reports/low-stock',
      );
      expect(calls.length).toBeGreaterThan(0);
      const url = new URL(calls[calls.length - 1]![0].url);
      expect(url.searchParams.get('storeId')).toBe('s1');
    });
    expect(await screen.findByText('SKU003')).toBeInTheDocument();
  });

  it('prompts to pick a store before the low-stock report can run', async () => {
    const fetch = mockApi(
      reference({ 'GET /reports/low-stock': { storeId: 's1', items: [], total: 0 } }),
    );

    renderPage();

    fireEvent.click(await screen.findByLabelText('สินค้าใกล้หมด'));

    // With no store chosen, the report cannot run — a prompt is shown and no request is sent.
    expect(await screen.findByText('กรุณาเลือกสาขาเพื่อดูสินค้าใกล้หมด')).toBeInTheDocument();
    const calls = fetch.mock.calls.filter(
      ([r]) => new URL(r.url).pathname === '/api/reports/low-stock',
    );
    expect(calls).toHaveLength(0);
  });

  it('sends the search query and store to the stock-on-hand endpoint', async () => {
    const fetch = mockApi(
      reference({
        'GET /reports/stock-on-hand': { storeId: 's1', items: [], total: 0 },
      }),
    );

    renderPage();

    await screen.findByRole('option', { name: 'B01 — Central' });
    fireEvent.change(screen.getByLabelText('ค้นหาสินค้า'), { target: { value: 'SKU003' } });
    fireEvent.change(screen.getByLabelText('สาขา'), { target: { value: 's1' } });

    await waitFor(() => {
      const calls = fetch.mock.calls.filter(
        ([r]) => new URL(r.url).pathname === '/api/reports/stock-on-hand',
      );
      expect(calls.length).toBeGreaterThan(0);
      const url = new URL(calls[calls.length - 1]![0].url);
      expect(url.searchParams.get('query')).toBe('SKU003');
      expect(url.searchParams.get('storeId')).toBe('s1');
    });
  });

  it('shows the Thai error state when the report request fails', async () => {
    mockApi(
      reference({
        'GET /reports/stock-on-hand': new Response('boom', { status: 500 }),
      }),
    );

    renderPage();

    // The query client retries a failed read once before surfacing the error, so allow for it.
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
      'เกิดข้อผิดพลาด',
    );
  });

  it('exports the stock-on-hand report to CSV with the current filters and triggers a download (RPT-04)', async () => {
    const fetch = mockApi(
      reference({
        'GET /reports/stock-on-hand': { storeId: 's1', items: [row()], total: 1 },
        'GET /reports/stock-on-hand/csv': {
          filename: 'stock-on-hand.csv',
          content: '\uFEFFSKU\r\nSKU003\r\n',
        },
      }),
    );
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    renderPage();

    await screen.findByRole('option', { name: 'B01 — Central' });
    fireEvent.change(screen.getByLabelText('ค้นหาสินค้า'), { target: { value: 'SKU003' } });
    fireEvent.change(screen.getByLabelText('สาขา'), { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่งออก CSV' }));

    await waitFor(() => {
      const calls = fetch.mock.calls.filter(
        ([r]) => new URL(r.url).pathname === '/api/reports/stock-on-hand/csv',
      );
      expect(calls.length).toBeGreaterThan(0);
      // The export carries the same filters as the on-screen report.
      const url = new URL(calls[calls.length - 1]![0].url);
      expect(url.searchParams.get('query')).toBe('SKU003');
      expect(url.searchParams.get('storeId')).toBe('s1');
    });
    // The resolved export triggered a browser download from the CSV content.
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalled();
  });
});
