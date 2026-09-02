import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { AppErrorBoundary } from './AppErrorBoundary.tsx';

test('unexpected child render error shows the S2 NAS fallback instead of a blank screen', () => {
  const originalError = console.error;
  console.error = () => undefined;

  function BrokenChild(): never {
    throw new Error('intentional test render failure');
  }

  try {
    const tree = TestRenderer.create(
      createElement(AppErrorBoundary, null, createElement(BrokenChild)),
    ).root;

    assert.equal(tree.findByProps({ role: 'alert' }).type, 'section');
    assert.ok(tree.findAllByType('h1').some((node) => node.children.join('') === 'ไม่สามารถแสดงหน้านี้ได้'));
    assert.ok(tree.findAllByType('button').some((node) => node.children.join('') === 'ลองใหม่'));
  } finally {
    console.error = originalError;
  }
});
