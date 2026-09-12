# HowTurn Android

React/Vite UI is shared by the browser and Android APK through Capacitor 8.
The Android app supports Android 7 (API 24) and newer, and targets API 36.
It bundles the web app; a development server is not needed after installation.
Map tiles, place search, and routing still require an internet connection.

## Build an installable APK

Requirements: Node.js 22+, Java 21 (bundled with Android Studio), Android SDK
Platform 36 and Build Tools 36. The build script uses Android Studio's bundled
Java on macOS; set `HOWTURN_JAVA_HOME` to override it, or `JAVA_HOME` on other
platforms. Set `ANDROID_HOME` if the SDK is not at its standard macOS location.

```sh
npm ci
npm run android:apk
```

The script runs TypeScript and Vite, syncs Capacitor, and builds a signed debug
APK at `../../../local-app/HowTurn-debug.apk`, relative to this app directory.
Open that APK on an Android device to install it. This is a development build;
release signing and store distribution are separate work.

By default, Gradle caches, build outputs and the debug signing key are placed
in `../../../local-app/`, outside this public repository. Set `HOWTURN_LOCAL_DIR`
to choose another external directory. `HOWTURN_BUILD_ROOT`, `GRADLE_USER_HOME`
and `HOWTURN_DEBUG_KEYSTORE` can override each location independently. Do not
commit generated APKs, private signing keys, SDKs or local configuration.

For Android Studio, first run `npm run android:apk` once to create the external
debug signing key, then:

```sh
npm run android:sync
npm run android:open
```

Android Studio can find the SDK from its own configuration. Its generated
`android/local.properties` is ignored. The native Gradle project also directs
build outputs and its default debug signing key to the external `local-app`
directory.

## Native behavior

- GPS uses Capacitor Geolocation and requests Android location permission when
  needed. Approximate location is accepted, but precise location is preferable
  for turn guidance. Denied permission, disabled GPS and timeouts produce
  actionable messages.
- `getCurrentFix()` in `src/lib/location.ts` is the shared one-shot API.
  `GpsProvider` uses the same native/browser boundary for continuous fixes and
  cancels callbacks when a watch is stopped, including an in-flight start.
- Android guidance uses a local `TextToSpeech` bridge because Android WebView
  cannot reliably provide the Web Speech API. The device must have a Chinese
  (Taiwan) voice installed in Android's text-to-speech settings.
- Navigation can hold the screen awake with an Android window flag; the flag
  is released when navigation ends. The browser retains its Wake Lock API path.
- `onAndroidBack()` lets React close the current panel first; otherwise the
  Android back action minimizes the app.
- This version supports foreground navigation. It does not implement a
  background location service or promise navigation while the app is suspended.

## Device checks

Before relying on navigation, verify on a physical Android device: first-run
permission grant/denial, approximate vs precise location, disabled GPS recovery,
route search with the keyboard open, back button/predictive back, Chinese speech
and mute, keeping the screen awake only during navigation, and returning from
another app. APK compilation does not establish GPS or speech behavior on-device.

Capacitor references: [environment setup](https://capacitorjs.com/docs/getting-started/environment-setup),
[Geolocation](https://capacitorjs.com/docs/apis/geolocation),
[Android configuration](https://capacitorjs.com/docs/android/configuration).
