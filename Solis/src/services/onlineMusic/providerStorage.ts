import type { OnlineProviderId } from '../../types/onlineMusic';

// src/services/onlineMusic/providerStorage.ts — TV 壳版。
// 只保留 provider 会话值的 localStorage 读写。
// 更完整的实现依赖 Dexie 应用数据库（services/db.ts），
// TV 壳不引入 Dexie，汽水内核也只使用会话函数，故裁去。

export const getProviderCacheKey = (providerId: OnlineProviderId, key: string): string => (
    `online_provider_${providerId}_${key}`
);

export const getProviderSessionKey = (providerId: OnlineProviderId, key: string): string => (
    `online_provider:${providerId}:${key}`
);

// Reads an old unscoped cache once, then stores the value in the provider namespace.
export const readProviderSessionValue = (
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): string | null => {
    if (typeof localStorage === 'undefined') return null;
    const namespacedKey = getProviderSessionKey(providerId, key);
    const current = localStorage.getItem(namespacedKey);
    if (current != null) return current;

    for (const legacyKey of legacyKeys) {
        const legacy = localStorage.getItem(legacyKey);
        if (legacy == null) continue;
        localStorage.setItem(namespacedKey, legacy);
        return legacy;
    }
    return null;
};

export const writeProviderSessionValue = (providerId: OnlineProviderId, key: string, value: string): void => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(getProviderSessionKey(providerId, key), value);
};

export const removeProviderSessionValue = (
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): void => {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(getProviderSessionKey(providerId, key));
    legacyKeys.forEach(legacyKey => localStorage.removeItem(legacyKey));
};
