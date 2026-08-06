"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, MapPin, X } from "lucide-react";
import { api } from "@/lib/api";
import { showNativeAppNotification } from "@/lib/native-notifications";

type GpsNotification = {
  id: string;
  title?: string | null;
  body?: string | null;
  message?: string | null;
  created_at?: string | null;
};

function notificationNumber(id: string): number {
  let value = 17;
  for (const char of id) value = ((value * 31) + char.charCodeAt(0)) | 0;
  return 20_000 + Math.abs(value % 500_000);
}

/**
 * Company-admin listener for GPS health events. It always shows an in-app
 * heads-up card and mirrors the event to Android/browser notifications when the
 * operating system has granted notification access.
 */
export function AdminGpsNotificationListener({ enabled }: { enabled: boolean }) {
  const seen = useRef(new Set<string>());
  const [alerts, setAlerts] = useState<GpsNotification[]>([]);

  useEffect(() => {
    if (!enabled) {
      setAlerts([]);
      return;
    }
    let cancelled = false;

    const dismiss = (id: string) => {
      setAlerts((current) => current.filter((alert) => alert.id !== id));
    };

    const show = async (notice: GpsNotification) => {
      const title = notice.title || "Salesman GPS alert";
      const message = notice.body || notice.message || "A salesman's GPS connection needs attention.";
      setAlerts((current) => [notice, ...current.filter((item) => item.id !== notice.id)].slice(0, 3));

      const shownNatively = await showNativeAppNotification({
        title,
        message,
        notificationId: notificationNumber(notice.id),
      });
      if (!shownNatively && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          const browserNotice = new Notification(title, {
            body: message,
            icon: "/icons/icon-192.png",
            tag: `gps-${notice.id}`,
          });
          browserNotice.onclick = () => {
            window.focus();
            window.location.assign("/dashboard/tracking");
            browserNotice.close();
          };
        } catch {
          // The in-app heads-up card remains the guaranteed delivery surface.
        }
      }
      window.setTimeout(() => dismiss(notice.id), 15_000);
    };

    const poll = async () => {
      try {
        const result = await api<{ data?: GpsNotification[] }>(
          "/api/v1/notifications?referenceType=SALESMAN_GPS&unread=true&limit=10",
          { noCache: true, suppressErrorLog: true },
        );
        if (cancelled) return;
        const fresh = (result.data || []).filter((notice) => notice.id && !seen.current.has(notice.id));
        if (fresh.length === 0) return;
        fresh.forEach((notice) => seen.current.add(notice.id));
        for (const notice of fresh.reverse()) await show(notice);
        await api("/api/v1/notifications", {
          method: "PUT",
          body: { notification_ids: fresh.map((notice) => notice.id) },
          suppressErrorLog: true,
        }).catch(() => {});
      } catch {
        // A later poll retries; the tracking page still shows live GPS health.
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  if (!enabled || alerts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-3 top-20 z-[120] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2 sm:right-5">
      {alerts.map((alert) => {
        const restored = (alert.title || "").toLowerCase().includes("restored");
        const Icon = restored ? CheckCircle2 : AlertTriangle;
        return (
          <div
            key={alert.id}
            className={`pointer-events-auto overflow-hidden rounded-2xl border bg-white shadow-2xl ${
              restored ? "border-emerald-200" : "border-red-200"
            }`}
          >
            <div className={`h-1 ${restored ? "bg-emerald-500" : "bg-red-500"}`} />
            <div className="flex items-start gap-3 p-4">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                restored ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
              }`}>
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-zinc-950">{alert.title || "Salesman GPS alert"}</p>
                <p className="mt-1 text-xs leading-5 text-zinc-600">
                  {alert.body || alert.message || "A salesman's GPS connection needs attention."}
                </p>
                <button
                  type="button"
                  onClick={() => window.location.assign("/dashboard/tracking")}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-700"
                >
                  <MapPin className="h-3.5 w-3.5" /> Open live tracking
                </button>
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => setAlerts((current) => current.filter((item) => item.id !== alert.id))}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
