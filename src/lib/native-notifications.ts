import { getAndroidNativePlugin } from "@/lib/capacitor-native-plugin";

type NativeNotificationPlugin = {
  showLoginNotification?: (input: { userName: string }) => Promise<{ shown?: boolean }>;
  showAppNotification?: (input: {
    title: string;
    message: string;
    notificationId?: number;
  }) => Promise<{ shown?: boolean }>;
};

function nativeNotificationPlugin(): NativeNotificationPlugin | null {
  return getAndroidNativePlugin<NativeNotificationPlugin>("BackgroundLocation");
}

export async function showNativeLoginNotification(userName: string): Promise<boolean> {
  const plugin = nativeNotificationPlugin();
  if (!plugin?.showLoginNotification) return false;
  try {
    const result = await plugin.showLoginNotification({ userName });
    return result?.shown === true;
  } catch {
    return false;
  }
}

export async function showNativeAppNotification(input: {
  title: string;
  message: string;
  notificationId?: number;
}): Promise<boolean> {
  const plugin = nativeNotificationPlugin();
  if (!plugin?.showAppNotification) return false;
  try {
    const result = await plugin.showAppNotification(input);
    return result?.shown === true;
  } catch {
    return false;
  }
}
