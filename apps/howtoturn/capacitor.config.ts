import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.howturn.mobile',
  appName: 'HowTurn',
  webDir: 'dist',
  android: { backgroundColor: '#f4f5f7', appendUserAgent: 'HowTurn/0.1 (app.howturn.mobile)' },
  plugins: {
    SystemBars: { style: 'LIGHT', initialViewportFitValueHint: 'cover' },
  },
};

export default config;
