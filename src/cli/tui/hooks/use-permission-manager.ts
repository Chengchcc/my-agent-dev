import { useEffect, useState } from 'react';
import {
  globalPermissionManager,
  type PermissionRequest,
  type PermissionResponse,
} from '../../../tools';

export function usePermissionManager() {
  const [request, setRequest] = useState<PermissionRequest | null>(null);

  useEffect(() => {
    return globalPermissionManager.subscribe((req) => {
      setRequest(req);
    });
  }, []);

  const respondToPermission = (response: PermissionResponse) => {
    if (request) {
      globalPermissionManager.respond(response);
    }
  };

  return {
    permissionRequest: request,
    respondToPermission,
  };
}
