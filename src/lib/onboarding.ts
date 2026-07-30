import { z } from 'zod';

import { describeError } from '@/lib/ai-pipeline';
import { ensureClientFolder } from '@/lib/google-drive';
import { isImageSizePresetId } from '@/lib/image-sizes';
import { prisma } from '@/lib/prisma';
import { addDays, HH_MM_PATTERN } from '@/lib/time';

/**
 * Client provisioning, shared by the Razorpay webhook and the dashboard's
 * manual onboarding form so both paths compute identical campaign windows and
 * Drive structures.
 */

export const clientProvisionSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is required').max(160),
  whatsappNumber: z
    .string()
    .trim()
    .min(8, 'WhatsApp number is required')
    .transform(normalizeWhatsappNumber)
    .refine((value) => /^\d{10,15}$/.test(value), {
      message: 'WhatsApp number must be 10–15 digits in international format',
    }),
  planId: z.string().uuid('A valid plan must be selected'),
  categoryId: z.string().uuid('A valid category must be selected'),
  cronTime: z
    .string()
    .trim()
    .regex(HH_MM_PATTERN, 'Delivery time must use 24-hour HH:MM format')
    .default('09:00'),
  /** Sales-demo tenant: provisioned identically, but skipped by the cron sweep. */
  isDemo: z.boolean().default(false),
  /**
   * Output-size preset id (src/lib/image-sizes.ts). Optional so the Razorpay
   * webhook — which has no size field to send — provisions on the fleet default
   * instead of failing validation.
   */
  imageSizePreset: z
    .string()
    .trim()
    .refine(isImageSizePresetId, 'Unknown image size preset')
    .nullish()
    .transform((value) => value ?? null),
});

export type ClientProvisionInput = z.input<typeof clientProvisionSchema>;

export interface ProvisionResult {
  created: boolean;
  clientId: string;
  companyName: string;
  startDate: Date;
  endDate: Date;
  gDriveFolderId: string | null;
  /** Set when the client row exists but Drive provisioning could not complete. */
  driveWarning?: string;
}

/**
 * Normalises a phone number to E.164 digits without `+`.
 * Bare 10-digit inputs are assumed Indian (the agency's home market) and get a
 * `91` country prefix; anything else is passed through digits-only.
 */
export function normalizeWhatsappNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

/**
 * Creates the client, its campaign window, and its isolated Drive folder.
 *
 * Idempotent by `(whatsappNumber, planId)` over a live campaign window, because
 * Razorpay redelivers `order.paid` on any non-2xx and on manual replay.
 */
export async function provisionClient(
  input: ClientProvisionInput,
): Promise<ProvisionResult> {
  const data = clientProvisionSchema.parse(input);

  const plan = await prisma.plan.findUnique({
    where: { id: data.planId },
    select: { id: true, durationDays: true, name: true },
  });
  if (!plan) {
    throw new Error(`Plan ${data.planId} does not exist`);
  }
  if (plan.durationDays < 1) {
    throw new Error(`Plan "${plan.name}" has an invalid durationDays (${plan.durationDays})`);
  }

  const category = await prisma.category.findUnique({
    where: { id: data.categoryId },
    select: { id: true },
  });
  if (!category) {
    throw new Error(`Category ${data.categoryId} does not exist`);
  }

  const now = new Date();

  const duplicate = await prisma.client.findFirst({
    where: {
      whatsappNumber: data.whatsappNumber,
      planId: data.planId,
      endDate: { gte: now },
      // Scoped by kind: a demo tenant must never collapse onto a paying client
      // that happens to share the number, nor the other way round.
      isDemo: data.isDemo,
    },
    select: {
      id: true,
      companyName: true,
      startDate: true,
      endDate: true,
      gDriveFolderId: true,
    },
  });

  if (duplicate) {
    return {
      created: false,
      clientId: duplicate.id,
      companyName: duplicate.companyName,
      startDate: duplicate.startDate,
      endDate: duplicate.endDate,
      gDriveFolderId: duplicate.gDriveFolderId,
    };
  }

  const startDate = now;
  const endDate = addDays(now, plan.durationDays);

  // Drive is a third-party dependency on the payment-success path. A failure
  // here must not lose a paying customer, so the row is still written and the
  // folder is flagged for repair from the dashboard.
  let gDriveFolderId: string | null = null;
  let driveWarning: string | undefined;

  try {
    gDriveFolderId = await ensureClientFolder(data.companyName);
  } catch (error) {
    driveWarning = describeError(error);
    console.error(
      `[ace:onboarding] Drive folder provisioning failed for "${data.companyName}": ${driveWarning}`,
    );
  }

  const client = await prisma.client.create({
    data: {
      companyName: data.companyName,
      whatsappNumber: data.whatsappNumber,
      cronTime: data.cronTime,
      startDate,
      endDate,
      isActive: true,
      isDemo: data.isDemo,
      gDriveFolderId,
      imageSizePreset: data.imageSizePreset,
      planId: plan.id,
      categoryId: category.id,
    },
    select: { id: true, companyName: true, startDate: true, endDate: true },
  });

  return {
    created: true,
    clientId: client.id,
    companyName: client.companyName,
    startDate: client.startDate,
    endDate: client.endDate,
    gDriveFolderId,
    ...(driveWarning ? { driveWarning } : {}),
  };
}

/** Retro-provisions a Drive folder for a client whose onboarding half-failed. */
export async function repairClientDriveFolder(clientId: string): Promise<string> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, companyName: true, gDriveFolderId: true },
  });
  if (!client) throw new Error(`Client ${clientId} does not exist`);
  if (client.gDriveFolderId) return client.gDriveFolderId;

  const gDriveFolderId = await ensureClientFolder(client.companyName);
  await prisma.client.update({
    where: { id: clientId },
    data: { gDriveFolderId },
  });

  return gDriveFolderId;
}
