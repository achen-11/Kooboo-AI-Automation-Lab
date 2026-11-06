import test from 'node:test';
import assert from 'node:assert/strict';
import { captureErrorMessage, safeErrorMessage } from '../server/lib/capture-error.js';

test('capture errors remove Playwright call logs, ANSI styling and credential values', () => {
  const error = new Error('page.screenshot: Clipped area is either empty or outside the resulting image\nCall log:\n\u001b[2m - waiting for fonts\u001b[22m');
  const diagnostic = captureErrorMessage(error);
  assert.match(diagnostic, /属于采集器错误/);
  assert.match(diagnostic, /Clipped area/);
  assert.doesNotMatch(diagnostic, /Call log|waiting for fonts|\u001b|检查采集环境/);
  const privateError = safeErrorMessage(new Error('failed https://user:password@site.test/page?token=private Bearer private-token\n\u001b[31m red\u001b[0m'));
  assert.doesNotMatch(privateError, /password|private-token|token=|\u001b|\n/);
});

test('timeouts and network failures retain actionable diagnostics after cleanup', () => {
  assert.match(captureErrorMessage(new Error('page.goto: Timeout 30000ms exceeded.\nCall log:\n - navigating')), /浏览器操作超时/);
  assert.match(captureErrorMessage(new Error('net::ERR_NAME_NOT_RESOLVED')), /域名解析失败/);
});
