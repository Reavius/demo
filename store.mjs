import fs from 'node:fs';
import path from 'node:path';

/**
 * Small single-instance persistent store used by venueCore.
 * Writes are synchronous and atomically renamed so requests in one Node process
 * never observe a partially-written file. Keep DATA_DIR on a persistent disk.
 */
export class JsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Не удалось прочитать файл данных ${this.filePath}: ${error.message}`);
      }
    }
  }

  get(key, fallback) {
    return Object.hasOwn(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    const json = JSON.stringify(this.data);
    fs.writeFileSync(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }
}
