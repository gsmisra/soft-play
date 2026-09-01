import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type BrowserChannel = 'chrome' | 'edge';

/**
 * Best-effort discovery of a local Chrome or Edge executable — deliberately
 * Chrome/Edge only, nothing else. Only existing, well-known install
 * locations are probed; nothing is ever downloaded or installed on the
 * user's behalf (see README "Browser choice" — this extension depends on
 * `playwright-core`, which never bundles or downloads a browser binary of
 * its own, unlike the full `playwright` package).
 *
 * `preferred` is tried first; if that channel isn't found, the other one is
 * tried as a fallback rather than failing outright — useful in a locked-down
 * environment where IT policy may have only one of the two installed.
 */
export function findChromeExecutable(preferred: BrowserChannel = 'chrome'): string | undefined {
  const candidatesByChannel = allCandidates();
  const order: BrowserChannel[] = preferred === 'edge' ? ['edge', 'chrome'] : ['chrome', 'edge'];

  for (const channel of order) {
    for (const candidate of candidatesByChannel[channel]) {
      try {
        if (candidate && fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Inaccessible path — keep searching.
      }
    }
  }
  return undefined;
}

function allCandidates(): Record<BrowserChannel, string[]> {
  const platform = process.platform;

  if (platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    return {
      chrome: [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ],
      edge: [
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]
    };
  }

  if (platform === 'darwin') {
    return {
      chrome: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ],
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    };
  }

  // Linux: Chrome/Edge only — deliberately no open-source Chromium package
  // path (e.g. /usr/bin/chromium-browser) is probed here, since this
  // extension only ever drives Chrome or Edge.
  return {
    chrome: ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'],
    edge: ['/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge']
  };
}

/**
 * Picks a --user-data-dir for the launched Chrome/Edge process.
 *
 * IMPORTANT CAVEAT (flagged, not silently assumed): recent Chrome/Edge
 * releases refuse to enable the remote-debugging port when pointed at the
 * browser's real default profile directory, as a phishing/hijack
 * mitigation. "Use real profile" is best effort — if the browser starts but
 * the CDP port never comes up, the workaround is a dedicated copy of the
 * profile directory rather than the live default one. This is called out in
 * the README and should be re-verified against whatever browser version the
 * target machine has.
 */
export function defaultUserDataDir(useRealProfile: boolean, channel: BrowserChannel): string {
  if (useRealProfile) {
    return realProfileDir(channel);
  }
  return path.join(os.tmpdir(), 'softplay-browser-profile');
}

function realProfileDir(channel: BrowserChannel): string {
  const platform = process.platform;
  const vendorDir = channel === 'edge' ? ['Microsoft', 'Edge'] : ['Google', 'Chrome'];

  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, ...vendorDir, 'User Data');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', ...vendorDir);
  }
  return path.join(os.homedir(), '.config', channel === 'edge' ? 'microsoft-edge' : 'google-chrome');
}
