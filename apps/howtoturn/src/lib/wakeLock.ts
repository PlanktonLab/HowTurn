import { isNativeAndroid, nativeGuidance } from './native';

/** Keep the screen on while navigating; re-acquires after the tab returns. */
export function acquireWakeLock(): () => void {
  if (isNativeAndroid) {
    void nativeGuidance.keepAwake({ enabled: true }).catch(() => {});
    return () => { void nativeGuidance.keepAwake({ enabled: false }).catch(() => {}); };
  }

  let sentinel: WakeLockSentinel | null = null;
  let released = false;

  const request = async () => {
    if (released || !("wakeLock" in navigator)) return;
    try {
      const next = await navigator.wakeLock.request("screen");
      if (released) await next.release();
      else sentinel = next;
    } catch {
      sentinel = null;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") request();
  };
  document.addEventListener("visibilitychange", onVisible);
  request();

  return () => {
    released = true;
    document.removeEventListener("visibilitychange", onVisible);
    sentinel?.release().catch(() => {});
    sentinel = null;
  };
}
