import { debugWarn } from '../utils/debug';

export type PermissionResponse = 'allow' | 'deny' | 'always';

export type PermissionRequest = {
  toolName: string;
  reason: string;
  resolve: (response: PermissionResponse) => void;
  reject: (error: Error) => void;
};

const MAX_QUEUE_SIZE = 10;

export class PermissionManager {
  private _queue: PermissionRequest[] = [];
  private _currentRequest: PermissionRequest | null = null;
  private _subscriber: ((req: PermissionRequest | null) => void) | null = null;

  requestPermission = (toolName: string, reason: string): Promise<PermissionResponse> => {
    return new Promise((resolve, reject) => {
      if (this._queue.length >= MAX_QUEUE_SIZE) {
        debugWarn('[PermissionManager] Queue overflow; rejecting request.');
        reject(new Error('Permission request queue overflow'));
        return;
      }
      this._queue.push({ toolName, reason, resolve, reject });
      this._processQueue();
    });
  };

  private _processQueue() {
    if (this._currentRequest || this._queue.length === 0) {
      if (this._queue.length === 0 && !this._currentRequest) {
        this._subscriber?.(null);
      }
      return;
    }

    this._currentRequest = this._queue.shift()!;
    this._subscriber?.(this._currentRequest);
  }

  respond = (response: PermissionResponse) => {
    if (!this._currentRequest) return;
    this._currentRequest.resolve(response);
    this._currentRequest = null;
    this._processQueue();
  };

  subscribe(callback: (req: PermissionRequest | null) => void) {
    this._subscriber = callback;
    if (this._currentRequest) {
      this._subscriber(this._currentRequest);
    } else if (this._queue.length === 0) {
      this._subscriber(null);
    }
    this._processQueue();
    return () => {
      this._subscriber = null;
      for (const req of this._queue) {
        req.reject(new Error('PermissionManager: subscriber unsubscribed'));
      }
      this._queue = [];
      if (this._currentRequest) {
        this._currentRequest.reject(new Error('PermissionManager: subscriber unsubscribed'));
        this._currentRequest = null;
      }
    };
  }
}

export const globalPermissionManager = new PermissionManager();
