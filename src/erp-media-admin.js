function storageSettings(config = {}) {
  const imageStorage = config.imageStorage || {};
  return {
    autoCleanup: imageStorage.autoCleanup !== false,
    retentionDays: Math.min(3650, Math.max(1, Number(imageStorage.retentionDays || 7))),
  };
}

export async function getMediaStorageStats({ config, store, getGeneratedStats }) {
  const [generated, erp] = await Promise.all([
    getGeneratedStats(config),
    store.storageStats(),
  ]);
  const totalCount = Number(generated.count || 0) + Number(erp.total.count || 0);
  const totalBytes = Number(generated.totalBytes || 0) + Number(erp.total.bytes || 0);
  return {
    ...generated,
    count: totalCount,
    totalBytes,
    generatedImages: {
      count: Number(generated.count || 0),
      bytes: Number(generated.totalBytes || 0),
    },
    erpImages: erp.images,
    erpVideos: erp.videos,
    total: { count: totalCount, bytes: totalBytes },
    disk: erp.disk || generated.disk || null,
  };
}

async function cleanupAllErpMedia(store) {
  const total = { deletedCount: 0, deletedBytes: 0, activeSkipped: 0 };
  for (let batch = 0; batch < 100; batch += 1) {
    const result = await store.cleanupExpired({ cutoff: Date.UTC(3000, 0, 1), limit: 500 });
    total.deletedCount += result.deletedCount;
    total.deletedBytes += result.deletedBytes;
    total.activeSkipped += result.activeSkipped;
    if (result.deletedCount + result.activeSkipped < 500 || result.deletedCount === 0) break;
  }
  return total;
}

export async function cleanupMediaStorage({
  config,
  store,
  mode = "expired",
  cleanupGenerated,
  getGeneratedStats,
}) {
  const settings = storageSettings(config);
  const before = await getMediaStorageStats({ config, store, getGeneratedStats });
  const generated = await cleanupGenerated(config, {
    mode: mode === "all" ? "all" : "expired",
    retentionDays: settings.retentionDays,
  });
  const erp = mode === "all"
    ? await cleanupAllErpMedia(store)
    : await store.cleanupExpired({
      cutoff: Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000,
      limit: 500,
    });
  const temporary = await store.cleanupTemporary();
  const after = await getMediaStorageStats({ config, store, getGeneratedStats });
  return {
    mode,
    retentionDays: settings.retentionDays,
    deletedCount: Number(generated.deletedCount || 0) + erp.deletedCount,
    deletedBytes: Number(generated.deletedBytes || 0) + erp.deletedBytes,
    activeSkipped: erp.activeSkipped,
    temporaryDeletedCount: temporary.deletedCount,
    generated,
    erp,
    before,
    after,
  };
}

export async function runAutoCleanupMediaStorage(dependencies) {
  const settings = storageSettings(dependencies.config);
  if (!settings.autoCleanup) {
    return { skipped: true, reason: "auto-cleanup-disabled" };
  }
  return cleanupMediaStorage({ ...dependencies, mode: "expired" });
}
