"use client";

import { useEffect, useRef } from "react";
import { api, getUser } from "@/lib/api";
import { getAndroidNativePlugin } from "@/lib/capacitor-native-plugin";

export interface SalesmanGpsStatus {
  locationServicesEnabled: boolean;
  fineLocationGranted: boolean;
  backgroundLocationGranted: boolean;
  notificationsGranted: boolean;
  batteryOptimizationDisabled: boolean;
  trackingActive: boolean;
}

type NativePlugin = {
  getGpsStatus: () => Promise<SalesmanGpsStatus>;
  showGpsOffWarning: () => Promise<void>;
  startTracking: (input: {
    authToken: string;
    refreshToken: string;
    companyId: string;
    userId: string;
    resumeActiveDuty: boolean;
  }) => Promise<void>;
};

function androidGpsPlugin(): NativePlugin | null {
  return getAndroidNativePlugin<NativePlugin>("BackgroundLocation");
}

/** Runs once in the dashboard shell so GPS health survives page navigation. */
export function SalesmanGpsGuardian({ enabled }: { enabled: boolean }) {
  const lastWarning = useRef(0);
  const lastReport = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const plugin = androidGpsPlugin();
    if (!plugin) return;
    let cancelled = false;
    let dutyActive = false;
    let lastDutyCheck = 0;
    let lastRestartAttempt = 0;

    const refreshDutyStatus = async (now: number) => {
      if (now - lastDutyCheck < 15_000) return;
      lastDutyCheck = now;
      try {
        const result = await api<{ data: { status?: string } | null }>("/api/v1/duty/session", {
          noCache: true,
          suppressErrorLog: true,
        });
        dutyActive = result.data?.status === "active";
      } catch {
        // Retain the last known state during a temporary network interruption.
      }
    };

    const restartActiveDutyService = async () => {
      const user = getUser() as { id?: string } | null;
      const authToken = localStorage.getItem("accessToken") || "";
      if (!user?.id || !authToken) return;
      await plugin.startTracking({
        authToken,
        refreshToken: localStorage.getItem("refreshToken") || "",
        companyId: localStorage.getItem("activeCompanyId") || "",
        userId: user.id,
        resumeActiveDuty: true,
      });
    };

    const checkGps = async () => {
      try {
        const now = Date.now();
        await refreshDutyStatus(now);
        let status = await plugin.getGpsStatus?.().catch(() => null);
        if (!status) return;

        // An app update or OS process reclaim can leave the saved duty flag behind
        // while the actual foreground service is gone. Reconcile against the
        // server-side duty session and restart the real native service, even when
        // Location Services are currently off, so the warning loop can run.
        if (dutyActive && !status.trackingActive && now - lastRestartAttempt >= 30_000) {
          lastRestartAttempt = now;
          await restartActiveDutyService().catch(() => {});
          status = (await plugin.getGpsStatus?.().catch(() => null)) || status;
        }

        if (cancelled) return;
        window.dispatchEvent(new CustomEvent("hometech:gps-status", { detail: status }));

        if (dutyActive && !status.locationServicesEnabled && now - lastWarning.current >= 45_000) {
          lastWarning.current = now;
          await plugin.showGpsOffWarning?.().catch(() => {});
        }

        if (dutyActive && (!status.locationServicesEnabled || now - lastReport.current >= 60_000)) {
          lastReport.current = now;
          await api("/api/v1/duty/gps-health", {
            method: "POST",
            body: {
              gps_enabled: status.locationServicesEnabled,
              permission_granted: status.fineLocationGranted,
              service_active: status.trackingActive,
              location_available: status.locationServicesEnabled && status.fineLocationGranted,
              device_platform: "android",
            },
            suppressErrorLog: true,
          }).catch(() => {});
        }
      } catch {
        // The foreground service continues independently while duty is active.
      }
    };

    void checkGps();
    const timer = window.setInterval(() => void checkGps(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return null;
}
