import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(process.env.HOWTURN_LOCAL_DIR || resolve(project, '../../../local-app'));
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) throw new Error('Android builds require Node.js 22 or newer.');
mkdirSync(local, { recursive: true });
const env = {
  ...process.env,
  GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || resolve(local, 'gradle'),
  HOWTURN_BUILD_ROOT: process.env.HOWTURN_BUILD_ROOT || resolve(local, 'android-build'),
  HOWTURN_DEBUG_KEYSTORE: process.env.HOWTURN_DEBUG_KEYSTORE || resolve(local, 'debug.keystore'),
};
const studioJava = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
// Android Studio's Java 21 takes precedence over an unrelated global Java 17.
if (process.env.HOWTURN_JAVA_HOME) env.JAVA_HOME = process.env.HOWTURN_JAVA_HOME;
else if (existsSync(studioJava)) env.JAVA_HOME = studioJava;
const macSdk = resolve(process.env.HOME || '', 'Library/Android/sdk');
if (!env.ANDROID_HOME && existsSync(macSdk)) env.ANDROID_HOME = macSdk;
function run(command, args, cwd = project) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
mkdirSync(dirname(env.HOWTURN_DEBUG_KEYSTORE), { recursive: true });
if (!existsSync(env.HOWTURN_DEBUG_KEYSTORE)) {
  const keytool = env.JAVA_HOME ? resolve(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool';
  run(keytool, ['-genkeypair', '-keystore', env.HOWTURN_DEBUG_KEYSTORE, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US']);
}
// Keep Capacitor on the same Node 22+ runtime that launched this script. A
// machine may still have an older `node` first on PATH even when this script
// was deliberately started with a newer binary.
run('npm', ['run', 'build']);
run(process.execPath, [resolve(project, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android']);
run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', ['--no-daemon', '--project-cache-dir', resolve(local, 'gradle-project-cache'), ':app:assembleDebug'], resolve(project, 'android'));
const apk = resolve(local, 'HowTurn-debug.apk');
copyFileSync(resolve(env.HOWTURN_BUILD_ROOT, 'app/outputs/apk/debug/app-debug.apk'), apk);
console.log(`\nInstallable debug APK: ${apk}`);
