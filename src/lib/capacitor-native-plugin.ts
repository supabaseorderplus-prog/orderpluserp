export interface CapacitorRuntimeBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
  registerPlugin?: (name: string) => unknown;
}

export function isAndroidNativeRuntime(
  capacitor: CapacitorRuntimeBridge | undefined,
): boolean {
  return Boolean(capacitor?.isNativePlatform?.() && capacitor.getPlatform?.() === "android");
}

/**
 * Resolve a Capacitor plugin from the Android WebView.
 *
 * Native Java registration only publishes a plugin header. The JavaScript proxy
 * does not exist until registerPlugin(name) is called, so checking Plugins alone
 * silently disables custom native functionality on a remote-hosted Capacitor app.
 */
export function resolveAndroidNativePlugin<T>(
  capacitor: CapacitorRuntimeBridge | undefined,
  name: string,
): T | null {
  if (!isAndroidNativeRuntime(capacitor)) return null;
  const existing = capacitor.Plugins?.[name] as T | undefined;
  if (existing) return existing;
  return (capacitor.registerPlugin?.(name) as T | undefined) || null;
}

export function isAndroidNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as Window & { Capacitor?: CapacitorRuntimeBridge }).Capacitor;
  return isAndroidNativeRuntime(capacitor);
}

export function getAndroidNativePlugin<T>(name: string): T | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as Window & { Capacitor?: CapacitorRuntimeBridge }).Capacitor;
  return resolveAndroidNativePlugin<T>(capacitor, name);
}
