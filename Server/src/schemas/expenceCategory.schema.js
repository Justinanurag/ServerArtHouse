/**
 * Pure validation helpers for expense category HTTP bodies (no DB).
 * Mirrors Mongoose rules in `expenceCategory.model.js`.
 */

const STATUSES = ['Active', 'Inactive'];

const slugFromName = name =>
  String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function validateExpenceCategoryCreateBody(body) {
  const errors = [];
  const name = String(body?.name ?? '').trim();
  const description = String(body?.description ?? '').trim();
  const statusRaw = String(body?.status ?? 'Active').trim() || 'Active';
  const slugRaw = String(body?.slug ?? '').trim().toLowerCase();

  if (!name) errors.push('Category name is required.');

  const status = STATUSES.includes(statusRaw) ? statusRaw : null;
  if (!status) errors.push('Status must be Active or Inactive.');

  if (errors.length) return {ok: false, errors};

  return {
    ok: true,
    data: {
      name,
      slug: slugRaw || slugFromName(name),
      description,
      status,
      createdBy: body?.createdBy ?? null,
    },
  };
}

export function validateExpenceCategoryUpdateBody(body) {
  const errors = [];
  const update = {};

  if (body?.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) errors.push('Category name cannot be empty.');
    else {
      update.name = name;
      if (body?.slug === undefined) update.slug = slugFromName(name);
    }
  }
  if (body?.slug !== undefined) {
    update.slug = String(body.slug ?? '').trim().toLowerCase();
  }
  if (body?.description !== undefined) {
    update.description = String(body.description ?? '').trim();
  }
  if (body?.status !== undefined) {
    const status = String(body.status ?? '').trim();
    if (!STATUSES.includes(status)) errors.push('Status must be Active or Inactive.');
    else update.status = status;
  }

  if (errors.length) return {ok: false, errors};
  if (Object.keys(update).length === 0) {
    return {ok: false, errors: ['No valid fields to update.']};
  }

  return {ok: true, data: update};
}
