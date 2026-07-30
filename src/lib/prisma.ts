import { PrismaClient } from '@prisma/client';

/**
 * Single Prisma instance per process. Next.js dev-mode hot reload re-evaluates
 * modules on every change, so the client is cached on `globalThis` to avoid
 * exhausting the Postgres connection pool.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
