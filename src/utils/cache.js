'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cache expiration time (7 days)
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Two-tier caching system for extracted code entities.
 * Uses in-memory cache for fast repeated access within a session,
 * and disk-based cache for persistence across runs.
 * Cache entries are invalidated when file mtime or size changes.
 */
class Cache {
  constructor(cacheDir) {
    this.cacheDir = cacheDir || path.join(process.cwd(), '.drift-cache');
    this.enabled = process.env.DRIFT_GUARDIAN_CACHE !== 'false';
    this.inMemoryCache = new Map();

    if (this.enabled) {
      this.ensureCacheDir();
    }
  }

  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Get cached value for a file
   * @param {string} filePath - Path to the file
   * @param {string} namespace - Cache namespace (e.g., 'entities', 'endpoints')
   * @returns {Object|null} Cached value or null if not found/expired
   */
  get(filePath, namespace = 'default') {
    if (!this.enabled) {
      return null;
    }

    const key = this.generateKey(filePath, namespace);

    // Check in-memory cache first
    if (this.inMemoryCache.has(key)) {
      return this.inMemoryCache.get(key);
    }

    // Check disk cache
    const cacheFilePath = this.getCacheFilePath(key);
    if (!fs.existsSync(cacheFilePath)) {
      return null;
    }

    try {
      const cached = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));

      // Validate cache is still valid
      if (!this.isValid(filePath, cached)) {
        fs.unlinkSync(cacheFilePath);
        return null;
      }

      // Store in memory for faster subsequent access
      this.inMemoryCache.set(key, cached.data);
      return cached.data;
    } catch (err) {
      return null;
    }
  }

  /**
   * Set cached value for a file
   * @param {string} filePath - Path to the file
   * @param {string} namespace - Cache namespace
   * @param {*} data - Data to cache
   */
  set(filePath, namespace = 'default', data) {
    if (!this.enabled) {
      return;
    }

    const key = this.generateKey(filePath, namespace);
    const hash = this.getFileHash(filePath);

    const cacheEntry = {
      hash,
      timestamp: Date.now(),
      data
    };

    // Store in memory
    this.inMemoryCache.set(key, data);

    // Store on disk
    const cacheFilePath = this.getCacheFilePath(key);
    try {
      fs.writeFileSync(cacheFilePath, JSON.stringify(cacheEntry), 'utf8');
    } catch (err) {
      // Ignore write errors (cache is optional)
    }
  }

  /**
   * Clear all cache
   */
  clear() {
    this.inMemoryCache.clear();

    if (!this.enabled || !fs.existsSync(this.cacheDir)) {
      return;
    }

    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
    } catch (err) {
      // Ignore errors
    }
  }

  /**
   * Clear cache older than specified age
   * @param {number} maxAgeMs - Max age in milliseconds (default: 7 days)
   */
  clearOld(maxAgeMs = DEFAULT_MAX_AGE_MS) {
    if (!this.enabled || !fs.existsSync(this.cacheDir)) {
      return;
    }

    const now = Date.now();
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        const filePath = path.join(this.cacheDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (err) {
      // Ignore errors
    }
  }

  generateKey(filePath, namespace) {
    const normalized = path.normalize(filePath);
    return crypto.createHash('sha256').update(`${namespace}:${normalized}`).digest('hex');
  }

  getCacheFilePath(key) {
    return path.join(this.cacheDir, `${key}.json`);
  }

  getFileHash(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const stats = fs.statSync(filePath);
      // Use mtime and size as a quick hash proxy
      return `${stats.mtimeMs}-${stats.size}`;
    } catch (err) {
      return null;
    }
  }

  isValid(filePath, cacheEntry) {
    const currentHash = this.getFileHash(filePath);
    return currentHash && currentHash === cacheEntry.hash;
  }
}

// Singleton instance
let globalCache = null;

function getCache() {
  if (!globalCache) {
    globalCache = new Cache();
  }
  return globalCache;
}

module.exports = {
  Cache,
  getCache
};
