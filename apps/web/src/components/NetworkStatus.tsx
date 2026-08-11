"use client";

import { Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

/** Top banner shown when browser network goes offline / comes back. */
export function NetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const [show, setShow] = useState(false);

  useEffect(() => {
    setIsOnline(navigator.onLine);

    const handleOnline = () => {
      setIsOnline(true);
      setShow(true);
      const t = setTimeout(() => setShow(false), 3000);
      return () => clearTimeout(t);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setShow(true);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!show) return null;

  return (
    <div
      role="alert"
      className={`fixed inset-x-0  top-0 z-50 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-transform duration-100 ${
        isOnline ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
      }`}
    >
      {isOnline ? (
        <>
          <Wifi className="size-4 " />
          <span>Network restored</span>
        </>
      ) : (
        <>
          <WifiOff className="size-4 " />
          <span>Connection lost. Some features may be unavailable.</span>
        </>
      )}
    </div>
  );
}
