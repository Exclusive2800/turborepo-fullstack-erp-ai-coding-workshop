---
name: add-feature
description: Step-by-step recipe and file templates for adding a feature end to end (Prisma model, contract, NestJS module, React page, tests). Use when adding or changing a model, API route, or screen.
---

# Add a feature (contract-first)

Work in this order. Each step makes the next one type-check.

## 1. Data model (`packages/database`)

Add or change models in `prisma/schema.prisma`, then create the migration:

```bash
pnpm db:migrate --name <describe_the_change>     # inside Docker: docker compose exec api pnpm db:migrate --name ...
```

- `migrate dev` does not run `prisma generate`. `pnpm dev` / `turbo` do it for you; run `pnpm db:generate` by hand only if types are stale.
- The client is generated into `packages/database/src/generated` (gitignored). Import `PrismaClient` and model types from `@erp/database`, never from the generated path.
- Seed data lives in `prisma/seed.ts` (`pnpm db:seed`). Use `upsert` so the seed is re-runnable.

## 2. Contract (`packages/contracts`)

Create `src/<feature>.ts`:

```ts
import { oc } from '@orpc/contract';
import * as z from 'zod';

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const CreateCustomerSchema = CustomerSchema.omit({ id: true });

export const customersContract = {
  list: oc
    .route({ method: 'GET', path: '/customers', summary: 'List customers', tags: ['Customers'] })
    .output(z.array(CustomerSchema)),
  create: oc
    .route({ method: 'POST', path: '/customers', summary: 'Create a customer', tags: ['Customers'] })
    .input(CreateCustomerSchema)
    .output(CustomerSchema),
};
```

Then in `src/index.ts`: `export * from './<feature>.js'` and add `<feature>: <feature>Contract` to the `contract` object.

- Paths are relative to the API's `/api` prefix. Path params: `path: '/customers/{id}'` with `.input(z.object({ id: z.string() }))`.
- All validation (lengths, enums, formats) goes here, not in the apps.
- Optional: a `src/<feature>.test.ts` that exercises the schemas with `safeParse` (see `src/health.test.ts`).

## 3. API (`apps/api`)

Create `src/<feature>/<feature>.module.ts` and `src/<feature>/<feature>.controller.ts`:

```ts
import { Controller } from '@nestjs/common';
import { contract } from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { PrismaService } from '../database/prisma.service.js';

@Controller()
export class CustomersController {
  constructor(private readonly prisma: PrismaService) {}

  @Implement(contract.customers.list)
  list() {
    return implement(contract.customers.list).handler(() => this.prisma.customer.findMany());
  }

  @Implement(contract.customers.create)
  create() {
    return implement(contract.customers.create).handler(({ input }) =>
      this.prisma.customer.create({ data: input }),
    );
  }
}
```

```ts
import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller.js';

@Module({ controllers: [CustomersController] })
export class CustomersModule {}
```

Register the module in `src/app.module.ts`. `PrismaService` is global, no import needed.

- `input` is already validated and typed by the contract. No DTOs, no `class-validator`.
- For errors use `ORPCError` from `@orpc/server` (e.g. `throw new ORPCError('NOT_FOUND')`).
- Auth: every route already requires a signed-in user. Imports come from `../auth/auth.decorators.js`:

  ```ts
  @Roles('ADMIN')                                   // optional: only these roles (else 403)
  @Implement(contract.customers.create)
  create(@CurrentUser() user: User) {               // User from @erp/contracts
    return implement(contract.customers.create).handler(({ input }) =>
      this.prisma.customer.create({ data: { ...input, createdById: user.id } }),
    );
  }
  ```

  Use `@Public()` only for routes that must work while signed out.
- Reference: `src/health/health.controller.ts`.

## 4. Web (`apps/web`)

- Read: `useQuery(orpc.customers.list.queryOptions())`, with input: `queryOptions({ input: { id } })`.
- Write: `useMutation(orpc.customers.create.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.customers.key() }) }))`.
- Page component in `src/routes/<feature>.tsx`, registered in `src/router.tsx` as a child of `RootLayout` (which is inside `RequireAuth`, so the page is protected). Reusable pieces in `src/components/`.
- The signed-in user: `const user = useCurrentUser()` from `@/lib/auth`. To hide UI by role: `user?.role === 'ADMIN'`. The API still enforces `@Roles`.
- Need a shadcn/ui primitive that is not in `src/components/ui` yet? From `apps/web`: `pnpm dlx shadcn@latest add <component>`.
- Reference: `src/components/health-status.tsx`.

## 5. Tests and checks

Write the api `*.spec.ts` and web `*.test.tsx` (see the `write-tests` skill), then run:

```bash
pnpm check        # lint + typecheck + test + build, from the repo root
```
