import { describe, expect, it, vi } from "vitest";
import { resolveAndroidNativePlugin } from "@/lib/capacitor-native-plugin";

describe("resolveAndroidNativePlugin", () => {
  it("registers a custom native plugin when Java published only its header", () => {
    const proxy = { startTracking: vi.fn() };
    const registerPlugin = vi.fn(() => proxy);
    const result = resolveAndroidNativePlugin<typeof proxy>({
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: {},
      registerPlugin,
    }, "BackgroundLocation");

    expect(result).toBe(proxy);
    expect(registerPlugin).toHaveBeenCalledOnce();
    expect(registerPlugin).toHaveBeenCalledWith("BackgroundLocation");
  });

  it("reuses an existing proxy without registering twice", () => {
    const proxy = { startTracking: vi.fn() };
    const registerPlugin = vi.fn();
    const result = resolveAndroidNativePlugin<typeof proxy>({
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: { BackgroundLocation: proxy },
      registerPlugin,
    }, "BackgroundLocation");

    expect(result).toBe(proxy);
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("does not expose the Android plugin in a normal browser", () => {
    const registerPlugin = vi.fn();
    const result = resolveAndroidNativePlugin({
      isNativePlatform: () => false,
      getPlatform: () => "web",
      Plugins: {},
      registerPlugin,
    }, "BackgroundLocation");

    expect(result).toBeNull();
    expect(registerPlugin).not.toHaveBeenCalled();
  });
});
