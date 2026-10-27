import { Test } from '@nestjs/testing';
import { duplicateCodeMessage } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service.js';
import { isUniqueConstraintError } from '../database/prisma-errors.js';
import { StoresController } from './stores.controller.js';

const row = {
  id: 's1',
  code: 'B01',
  name: 'Central',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

async function createController(store: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [StoresController],
    providers: [{ provide: PrismaService, useValue: { store } }],
  }).compile();
  return moduleRef.get(StoresController);
}

describe('StoresController', () => {
  it('lists stores newest first with pagination metadata', async () => {
    const findMany = vi.fn().mockResolvedValue([row]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ findMany, count });

    const result = await call(controller.list(), { page: 1, pageSize: 20 });

    expect(result).toEqual({
      items: [
        { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }),
    );
  });

  it('creates a store', async () => {
    const create = vi.fn().mockResolvedValue(row);
    const controller = await createController({ create });

    await expect(
      call(controller.create(), { code: 'B01', name: 'Central' }),
    ).resolves.toMatchObject({ id: 's1', code: 'B01' });
    expect(create).toHaveBeenCalledWith({ data: { code: 'B01', name: 'Central' } });
  });

  it('rejects a duplicate code with an actionable Thai message', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002', meta: { target: ['code'] } });
    const controller = await createController({ create });

    await expect(call(controller.create(), { code: 'B01', name: 'Central' })).rejects.toMatchObject(
      { code: 'CONFLICT', message: duplicateCodeMessage('B01') },
    );
  });

  it('updates a store', async () => {
    const update = vi.fn().mockResolvedValue({ ...row, name: 'Central Plaza' });
    const controller = await createController({ update });

    await expect(
      call(controller.update(), { id: 's1', code: 'B01', name: 'Central Plaza' }),
    ).resolves.toMatchObject({ name: 'Central Plaza' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { code: 'B01', name: 'Central Plaza' },
    });
  });
});

// The P2002 detection is a seam the controller relies on; pin its behaviour here.
describe('isUniqueConstraintError', () => {
  it('matches a Prisma P2002 error', () => {
    expect(isUniqueConstraintError({ code: 'P2002' })).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isUniqueConstraintError(new Error('nope'))).toBe(false);
    expect(isUniqueConstraintError({ code: 'P2025' })).toBe(false);
  });
});
