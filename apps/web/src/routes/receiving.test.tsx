import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_LIST_MESSAGE, GR_OVER_RECEIVE_MESSAGE } from '@erp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { conflict, mockApi } from '@/test/mock-api';
import { ReceivingPage } from './receiving';

const staff = { id: '2', email: 'staff_b01@erp.local', name: 'Staff B01', role: 'STAFF' };

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ReceivingPage />
    </QueryClientProvider>,
  );
}

function list(items: unknown[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

const approvedOrder = {
  id: 'po1',
  number: 'PO-DEMO-001',
  status: 'APPROVED',
  statusReason: null,
  supplierId: 'sup1',
  storeId: 's1',
  expectedReceiptDate: '2026-02-01T00:00:00.000Z',
  total: '900.00',
  lines: [
    {
      id: 'pol1',
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

const receivableView = {
  id: 'po1',
  number: 'PO-DEMO-001',
  status: 'APPROVED',
  storeId: 's1',
  lines: [
    {
      purchaseOrderLineId: 'pol1',
      productId: 'p1',
      sku: 'SKU001',
      productName: 'Drinking water pack of 6',
      ordered: 20,
      received: 0,
      outstanding: 20,
    },
  ],
};

function referenceData(extra: Record<string, unknown> = {}) {
  return {
    'GET /auth/me': { user: staff },
    'GET /purchase-orders': list([approvedOrder]),
    'GET /goods-receipts/receivable/po1': receivableView,
    ...extra,
  };
}

describe('ReceivingPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a Thai empty state when there are no receivable orders', async () => {
    mockApi(referenceData({ 'GET /purchase-orders': list([]) }));

    renderPage();

    expect(await screen.findByText(EMPTY_LIST_MESSAGE)).toBeInTheDocument();
  });

  it('lists receivable orders and shows ordered/received/outstanding when one is opened', async () => {
    mockApi(referenceData());

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'รับสินค้า PO-DEMO-001' }));

    // The per-line receiving table shows ordered, received and outstanding.
    const row = await screen.findByRole('row', { name: /SKU001/ });
    expect(row).toHaveTextContent('20'); // ordered
    expect(row).toHaveTextContent('0'); // received
    // Outstanding is also shown and prefills the quantity input.
    expect(screen.getByLabelText('จำนวนที่รับ SKU001')).toHaveValue(20);
  });

  it('sends the typed receive payload when confirmed', async () => {
    const fetch = mockApi(
      referenceData({
        'POST /goods-receipts': {
          id: 'gr1',
          number: 'GR-000001',
          purchaseOrderId: 'po1',
          storeId: 's1',
          receivedById: '2',
          lines: [
            {
              id: 'grl1',
              purchaseOrderLineId: 'pol1',
              productId: 'p1',
              sku: 'SKU001',
              productName: 'Drinking water pack of 6',
              quantity: 8,
            },
          ],
          createdAt: new Date().toISOString(),
        },
      }),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'รับสินค้า PO-DEMO-001' }));
    const qty = await screen.findByLabelText('จำนวนที่รับ SKU001');
    fireEvent.change(qty, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันการรับสินค้า' }));

    await waitFor(() => {
      const post = fetch.mock.calls.find(([r]) => r.method === 'POST');
      expect(post).toBeTruthy();
      expect(new URL(post![0].url).pathname).toBe('/api/goods-receipts');
    });
    const post = fetch.mock.calls.find(([r]) => r.method === 'POST')![0];
    await expect(post.json()).resolves.toMatchObject({
      purchaseOrderId: 'po1',
      lines: [{ purchaseOrderLineId: 'pol1', quantity: 8 }],
    });
  });

  it('shows the actionable Thai message when the API rejects an over-receive', async () => {
    mockApi(referenceData({ 'POST /goods-receipts': conflict(GR_OVER_RECEIVE_MESSAGE) }));

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'รับสินค้า PO-DEMO-001' }));
    const qty = await screen.findByLabelText('จำนวนที่รับ SKU001');
    fireEvent.change(qty, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันการรับสินค้า' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('เกิน');
  });
});
