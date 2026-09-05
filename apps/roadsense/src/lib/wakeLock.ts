/** Keep the screen on while navigating; re-acquires after the tab returns. */
export function acquireWakeLock(): () => void {
  let sentinel: WakeLockSentinel | null = null;
  let released = false;

  const request = async () => {
    if (released || !("wakeLock" in navigator)) return;
    try {
      sentinel = await navigator.wakeLock.request("screen");
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
