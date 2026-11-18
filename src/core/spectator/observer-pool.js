import { ObserverClient } from './observer-client.js';
import { normalizePlatformId } from './regions.js';

// The two views keep their own cadence. When both follow the same game,
// serialize their requests and reuse its latest immutable keyframe.
export class ObserverPool {
  constructor(createClient = (options) => new ObserverClient(options)) {
    this.createClient = createClient;
    this.games = new Map();
  }

  acquire({ platformId, gameId }) {
    const key = normalizePlatformId(platformId) + ':' + gameId;
    let game = this.games.get(key);
    if (!game) {
      game = { client: this.createClient({ platformId, gameId }), users: 0, pending: new Map(),
        tail: Promise.resolve(), frame: null, retryAt: 0, limitError: null };
      this.games.set(key, game);
    }
    game.users++;
    let released = false;
    const request = (method, id) => {
      if (released) return Promise.reject(new Error('Observer subscription ended.'));
      if (method === 'getKeyFrame' && game.frame?.id === id) return Promise.resolve(game.frame.bytes);
      const resource = method + ':' + (id ?? '');
      if (game.pending.has(resource)) return game.pending.get(resource);
      const task = game.tail.then(async () => {
        if (Date.now() < game.retryAt) throw game.limitError;
        const data = await (id === undefined ? game.client[method]() : game.client[method](id));
        if (method === 'getKeyFrame' && data && game.users > 1) game.frame = { id, bytes: data };
        return data;
      }).catch((error) => {
        if (error?.statusCode === 429 && error !== game.limitError) {
          game.retryAt = Date.now() + Math.max(30_000, error.retryAfterMs || 0);
          game.limitError = error;
        }
        throw error;
      }).finally(() => game.pending.delete(resource));
      game.pending.set(resource, task);
      game.tail = task.catch(() => {});
      return task;
    };
    return {
      // The monitor may attach its installed-version fallback to this copy.
      getMetadata: async () => ({ ...await request('getMetadata') }),
      getLastChunkInfo: () => request('getLastChunkInfo'),
      getKeyFrame: (id) => request('getKeyFrame', id),
      getChunk: (id) => request('getChunk', id),
      release: () => {
        if (released) return;
        released = true;
        game.users--;
        if (game.users <= 1) game.frame = null;
        if (!game.users) {
          this.games.delete(key);
          // ObserverClient uses finite HTTP requests. Let an in-flight one finish.
          void game.tail.then(() => game.client.close()).catch(() => {});
        }
      }
    };
  }
}

export const liveObservers = new ObserverPool();
