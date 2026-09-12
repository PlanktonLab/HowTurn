import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';

interface HowTurnNativePlugin {
  speak(options: { text: string; interrupt: boolean }): Promise<void>;
  stopSpeaking(): Promise<void>;
  keepAwake(options: { enabled: boolean }): Promise<void>;
}

export const isNativeAndroid = Capacitor.getPlatform() === 'android';
export const nativeGuidance = registerPlugin<HowTurnNativePlugin>('HowTurnNative');

/** Return true when a sheet or navigation session handled the back action. */
export function onAndroidBack(handler: () => boolean): () => void {
  if (!isNativeAndroid) return () => {};
  let disposed = false;
  const listener = App.addListener('backButton', () => {
    if (!disposed && !handler()) void App.minimizeApp();
  });
  return () => {
    disposed = true;
    void listener.then((handle) => handle.remove());
  };
}
