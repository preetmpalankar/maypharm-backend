import { z } from 'zod';
import { paginationSchema } from '../pagination';

export const contentTypes = [
  'product',
  'clinical',
  'academy',
  'media',
  'field_asset',
  'regulatory',
] as const;

export const contentStatuses = [
  'draft',
  'review',
  'approved',
  'archived',
] as const;
export const recordStatuses = ['active', 'archived'] as const;
export const roles = [
  'admin',
  'medical',
  'marketing',
  'sales',
  'viewer',
] as const;
export const profileStatuses = ['invited', 'active', 'suspended'] as const;

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer.`)
    .nullish()
    .transform((value) => value || null);

const metadataSchema = z
  .record(
    z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/, 'Invalid detail field name.'),
    z.string().trim().max(500, 'Each detail must be 500 characters or fewer.'),
  )
  .refine((value) => Object.keys(value).length <= 30, 'Too many detail fields.')
  .transform((value) =>
    Object.fromEntries(
      Object.entries(value).filter(([, text]) => text.length > 0),
    ),
  );

export const contentInputSchema = z.object({
  /** Optional: a new item is named after its first file; an edit keeps its title. */
  title: z
    .string()
    .trim()
    .max(180, 'Title must be 180 characters or fewer.')
    .optional(),
  contentType: z.enum(contentTypes, { error: 'Choose a data type.' }),
  category: z
    .string()
    .trim()
    .max(120, 'Category must be 120 characters or fewer.')
    .default(''),
  productName: optionalText(160, 'Product name'),
  /** Every item is filed under a brand. */
  brandId: z.uuid({ error: 'Choose a brand.' }),
  status: z.enum(contentStatuses, { error: 'Choose a status.' }),
  description: z
    .string()
    .trim()
    .max(2000, 'Summary must be 2000 characters or fewer.')
    .default(''),
  metadata: metadataSchema.default({}),
  /** Optional free-form details shown to users, e.g. "Pack size": "10 x 10". */
  customFields: z
    .array(
      z.object({
        label: z
          .string({ error: 'Each custom field needs a title.' })
          .trim()
          .min(1, 'Each custom field needs a title.')
          .max(80, 'Custom field titles must be 80 characters or fewer.'),
        value: z
          .string({ error: 'Each custom field needs a value.' })
          .trim()
          .min(1, 'Each custom field needs a value.')
          .max(1000, 'Custom field values must be 1000 characters or fewer.'),
      }),
    )
    .max(30, 'Add at most 30 custom fields.')
    .default([]),
  // Uploads to attach (in order) and attached files to remove.
  uploadIntentIds: z
    .array(z.uuid({ error: 'Invalid upload reference.' }))
    .max(20, 'Attach at most 20 files to one item.')
    .default([]),
  removeFileIds: z
    .array(z.uuid({ error: 'Invalid file reference.' }))
    .max(20)
    .default([]),
  aiIngestion: z.boolean().default(true),
});

export const contentListQuerySchema = paginationSchema.extend({
  status: z.enum(contentStatuses).optional(),
  type: z.enum(contentTypes).optional(),
  brandId: z.uuid().optional(),
  q: z.string().trim().min(1).max(80).optional(),
});

export const brandInputSchema = z.object({
  name: z
    .string({ error: 'Brand name is required.' })
    .trim()
    .min(2, 'Brand name must be at least 2 characters.')
    .max(120, 'Brand name must be 120 characters or fewer.'),
  category: z
    .string({ error: 'Choose a category.' })
    .trim()
    .min(2, 'Choose a category.')
    .max(120, 'Category must be 120 characters or fewer.'),
  description: z
    .string()
    .trim()
    .max(600, 'Description must be 600 characters or fewer.')
    .default(''),
  status: z
    .enum(recordStatuses, { error: 'Choose a status.' })
    .default('active'),
  sortOrder: z.coerce
    .number({ error: 'Sort order must be a number.' })
    .int('Sort order must be a whole number.')
    .min(0, 'Sort order cannot be negative.')
    .max(9999, 'Sort order must be 9999 or less.')
    .default(0),
  logoIntentId: z.uuid({ error: 'Invalid upload reference.' }).nullish(),
  removeLogo: z.boolean().default(false),
  /** Everyone, or only the chosen people (and admins). */
  accessMode: z
    .enum(['everyone', 'restricted'], { error: 'Choose who can access it.' })
    .default('everyone'),
  accessUserIds: z
    .array(z.uuid({ error: 'Invalid user.' }))
    .max(2000, 'Too many people selected.')
    .default([]),
});

export const categoryInputSchema = z.object({
  name: z
    .string({ error: 'Category name is required.' })
    .trim()
    .min(2, 'Category name must be at least 2 characters.')
    .max(120, 'Category name must be 120 characters or fewer.'),
  description: z
    .string()
    .trim()
    .max(600, 'Description must be 600 characters or fewer.')
    .default(''),
  status: z
    .enum(recordStatuses, { error: 'Choose a status.' })
    .default('active'),
  sortOrder: z.coerce
    .number({ error: 'Sort order must be a number.' })
    .int('Sort order must be a whole number.')
    .min(0, 'Sort order cannot be negative.')
    .max(9999, 'Sort order must be 9999 or less.')
    .default(0),
});

export const recordListQuerySchema = paginationSchema.extend({
  status: z.enum(recordStatuses).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});

const passwordSchema = z
  .string({ error: 'Password is required.' })
  .min(12, 'Password must be at least 12 characters.')
  .max(128, 'Password must be 128 characters or fewer.');

export const createUserSchema = z.object({
  email: z
    .email({ error: 'Enter a valid email address.' })
    .trim()
    .toLowerCase(),
  fullName: z
    .string({ error: 'Full name is required.' })
    .trim()
    .min(2, 'Full name must be at least 2 characters.')
    .max(120, 'Full name must be 120 characters or fewer.'),
  password: passwordSchema,
  role: z.enum(roles, { error: 'Choose a role.' }),
  territory: optionalText(120, 'Territory'),
});

export const updateUserSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Full name must be at least 2 characters.')
      .max(120, 'Full name must be 120 characters or fewer.')
      .optional(),
    role: z.enum(roles, { error: 'Choose a role.' }).optional(),
    status: z.enum(profileStatuses, { error: 'Choose a status.' }).optional(),
    territory: optionalText(120, 'Territory').optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: 'Nothing to update.',
    },
  );

export const resetPasswordSchema = z.object({ password: passwordSchema });

export const userListQuerySchema = paginationSchema.extend({
  role: z.enum(roles).optional(),
  status: z.enum(profileStatuses).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});

export const uploadSlotSchema = z
  .object({
    kind: z.enum(['content', 'logo'], { error: 'Invalid upload kind.' }),
    fileName: z
      .string({ error: 'File name is required.' })
      .trim()
      .min(1, 'File name is required.')
      .max(255, 'File name is too long.'),
    fileSize: z
      .number({ error: 'File size is required.' })
      .int('Invalid file size.')
      .positive('The selected file is empty.'),
    contentType: z.enum(contentTypes).optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === 'content' && !value.contentType) {
      context.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: 'Choose a data type before attaching a file.',
      });
    }
  });

export const auditListQuerySchema = paginationSchema.extend({
  entityType: z.string().trim().min(1).max(60).optional(),
  action: z.string().trim().min(1).max(60).optional(),
});
