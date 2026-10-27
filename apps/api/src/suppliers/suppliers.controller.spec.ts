import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { duplicateCodeMessage } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { SuppliersController } from './suppliers.controller.js';

const row = {
  id: 'sup1',
  code: 'SUP01',
  name: 'SupplyOne',
  contactName: 'Somchai',
  contactEmail: 'somchai@supplyone.co.th',
  contactPhone: '02-123-4567',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

async function createController(supplier: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [SuppliersController],
    providers: [{ provide: PrismaService, useValue: { supplier } }],
  }).compile();
  return moduleRef.get(SuppliersController);
}

describe('SuppliersController', () => {
  it('lists suppliers newest first with pagination metadata', async () => {
    const findMany = vi.fn().mockResolvedValue([row]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ findMany, count });

    const result = await call(controller.list(), { page: 1, pageSize: 20 });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ code: 'SUP01', contactName: 'Somchai' });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }),
    );
  });

  it('creates a supplier, normalising empty contact fields to null', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ ...row, contactName: null, contactEmail: null, contactPhone: null });
    const controller = await createController({ create });

    await call(controller.create(), { code: 'SUP01', name: 'SupplyOne', contactEmail: '' });

    expect(create).toHaveBeenCalledWith({
      data: {
        code: 'SUP01',
        name: 'SupplyOne',
        contactName: null,
        contactEmail: null,
        contactPhone: null,
      },
    });
  });

  it('rejects a duplicate code with an actionable Thai message', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002', meta: { target: ['code'] } });
    const controller = await createController({ create });

    await expect(
      call(controller.create(), { code: 'SUP01', name: 'SupplyOne' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: duplicateCodeMessage('SUP01') });
  });

  it('updates a supplier', async () => {
    const update = vi.fn().mockResolvedValue({ ...row, name: 'SupplyOne Co' });
    const controller = await createController({ update });

    await expect(
      call(controller.update(), { id: 'sup1', code: 'SUP01', name: 'SupplyOne Co' }),
    ).resolves.toMatchObject({ name: 'SupplyOne Co' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'sup1' },
      data: {
        code: 'SUP01',
        name: 'SupplyOne Co',
        contactName: null,
        contactEmail: null,
        contactPhone: null,
      },
    });
  });

  // Authz: pin that the write handlers carry @Roles('ADMIN') and the read handler is open, so
  // dropping the decorator turns this red (the global AuthGuard enforcement is in auth.guard.spec.ts).
  it('restricts create and update to ADMIN and leaves list open', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, SuppliersController.prototype.create)).toEqual(['ADMIN']);
    expect(reflector.get(ROLES_KEY, SuppliersController.prototype.update)).toEqual(['ADMIN']);
    expect(reflector.get(ROLES_KEY, SuppliersController.prototype.list)).toBeUndefined();
  });
});
