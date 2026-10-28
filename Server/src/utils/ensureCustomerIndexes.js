/**
 * Fix unique customerId index.
 *
 * Old index: unique + sparse on customerId.
 * Mongoose defaulted customerId to null, and sparse unique still indexes null,
 * so only ONE customer without a portal id could ever be created.
 *
 * Also: mongoose autoIndex can recreate the legacy index after startup, so we
 * drop any non-partial unique customerId index every time.
 */
const PARTIAL_NAME = 'customerId_unique_partial';

const dropLegacyCustomerIdIndexes = async col => {
  const indexes = await col.indexes();
  for (const idx of indexes) {
    const isCustomerIdKey = idx?.key?.customerId === 1;
    if (!isCustomerIdKey) continue;
    if (idx.name === PARTIAL_NAME) continue;
    try {
      await col.dropIndex(idx.name);
      console.log(`🧹 Dropped legacy customer index: ${idx.name}`);
    } catch (error) {
      if (error?.codeName !== 'IndexNotFound') {
        console.warn(`Could not drop ${idx.name}:`, error.message);
      }
    }
  }
};

export const ensureCustomerIndexes = async db => {
  const col = db.collection('customers');

  // Remove null/empty placeholders so partial unique index can work
  await col.updateMany(
    {
      $or: [{customerId: null}, {customerId: ''}],
    },
    {$unset: {customerId: ''}},
  );

  await dropLegacyCustomerIdIndexes(col);

  const indexes = await col.indexes();
  const hasPartial = indexes.some(idx => idx.name === PARTIAL_NAME);
  if (!hasPartial) {
    await col.createIndex(
      {customerId: 1},
      {
        unique: true,
        name: PARTIAL_NAME,
        partialFilterExpression: {
          customerId: {$type: 'string', $gt: ''},
        },
      },
    );
    console.log(`✅ Ensured ${PARTIAL_NAME} index`);
  }

  // Mongoose autoIndex can recreate the legacy sparse unique a moment later.
  setTimeout(() => {
    dropLegacyCustomerIdIndexes(col).catch(error => {
      console.warn('Delayed customerId index cleanup failed:', error.message);
    });
  }, 4000);
};
