import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canBindLoopback, canOpenBrowser } from './preflight.js';

describe('preflight', () => {
  it('opens browsers on desktop platforms', async () => {
    assert.equal((await canOpenBrowser('darwin', {})).verdict, 'possible');
    assert.equal((await canOpenBrowser('win32', {})).verdict, 'possible');
  });

  it('detects headless linux', async () => {
    const headless = await canOpenBrowser('linux', {});
    assert.equal(headless.verdict, 'impossible');
    const display = await canOpenBrowser('linux', { DISPLAY: ':0' });
    assert.equal(display.verdict, 'unknown');
  });

  it('binds an OS-assigned loopback port', async () => {
    const result = await canBindLoopback(0);
    assert.equal(result.verdict, 'possible');
  });
});
