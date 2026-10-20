/**
 * Pre-sign-in environment checks for the browser flow.
 *
 * The browser grant needs three things this process can verify cheaply before
 * opening anything: a desktop session to open the browser in, a loopback
 * listener to catch the redirect on, and a Redmine reachable over the network
 * that actually serves an OAuth provider. When the first two are verifiably
 * absent the provider skips the browser attempt instead of failing through
 * it; reachability is warn-only, because a failed probe must never stop a
 * sign-in that would have worked.
 *
 * Every check is non-throwing. Tests inject fakes through
 * `createAuthProvider({ preflight })`; nothing here is read from the network
 * in the suite.
 */

import net from 'node:net';

/** What one check concluded. `unknown` keeps the current behaviour. */
export type PreflightVerdict = 'possible' | 'impossible' | 'unknown';

export interface PreflightResult {
  verdict: PreflightVerdict;
  /** One line a warning can quote. Always present, whatever the verdict. */
  reason: string;
}

/** The checks `login` consults, injectable as a unit for tests. */
export interface PreflightChecks {
  canOpenBrowser(): Promise<PreflightResult>;
  canBindLoopback(port: number): Promise<PreflightResult>;
  canReachRedmine(): Promise<PreflightResult>;
}

/**
 * Whether a browser opened from this process could be seen.
 *
 * macOS and Windows need no display variable: `open` and `start` target the
 * console session. Everywhere else a missing `DISPLAY`/`WAYLAND_DISPLAY` means
 * headless (SSH, a container, CI) and the browser attempt cannot work. A set
 * variable proves little — the display may still be unreachable — so that
 * stays `unknown` and the attempt goes ahead as before.
 */
export async function canOpenBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreflightResult> {
  try {
    if (platform === 'darwin' || platform === 'win32') {
      return { verdict: 'possible', reason: `${platform} opens the browser in the console session` };
    }
    const display = env['DISPLAY'] ?? env['WAYLAND_DISPLAY'] ?? '';
    if (display.trim() === '') {
      return {
        verdict: 'impossible',
        reason: 'no desktop session (neither DISPLAY nor WAYLAND_DISPLAY is set)',
      };
    }
    return { verdict: 'unknown', reason: `a display is set (${display.trim()}) but no browser was checked` };
  } catch (error) {
    return { verdict: 'unknown', reason: `browser check failed: ${String(error)}` };
  }
}

/**
 * Whether the loopback redirect listener can bind.
 *
 * Port 0 asks the OS for a free port, so the check binds exactly that and
 * reports what it got. A fixed port is probed by attempting it once.
 */
export async function canBindLoopback(port: number): Promise<PreflightResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ verdict: 'impossible', reason: `loopback port ${port} is unavailable (${error.code ?? error.message})` });
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      server.close(() => resolve({ verdict: 'possible', reason: `loopback port ${bound} binds` }));
    });
  });
}

/**
 * Whether Redmine answers at all. Warn-only: proxies, VPNs, and captive
 * portals make this flaky, and a wrong `impossible` here would block a
 * sign-in that would have worked.
 */
export async function canReachRedmine(redmineUrl: string, timeoutMs = 5000): Promise<PreflightResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(redmineUrl, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
    return { verdict: 'possible', reason: `Redmine answered with HTTP ${res.status}` };
  } catch (error) {
    return {
      verdict: 'unknown',
      reason: `Redmine reachability probe failed (${error instanceof Error ? error.message : String(error)}); continuing anyway`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The default checks, bound to a Redmine URL. */
export function defaultPreflight(redmineUrl: string): PreflightChecks {
  return {
    canOpenBrowser: () => canOpenBrowser(),
    canBindLoopback: (port: number) => canBindLoopback(port),
    canReachRedmine: () => canReachRedmine(redmineUrl),
  };
}
