const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const events = {};
  const windowEvents = {};
  const captures = new Set();
  const values = {};
  let resized = 0;
  const layout = { clientWidth: 1200, style: { setProperty(key, value) { values[key] = value; } } };
  const handle = {
    attributes: {},
    addEventListener(event, listener) { events[event] = listener; },
    setAttribute(key, value) { this.attributes[key] = value; },
    focus() {},
    setPointerCapture(id) { captures.add(id); },
    hasPointerCapture(id) { return captures.has(id); },
    releasePointerCapture(id) { captures.delete(id); }
  };
  const context = {
    document: { getElementById(id) { return id === 'mainLayout' ? layout : handle; } },
    window: { addEventListener(event, listener) { windowEvents[event] = listener; } }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sidebar-resize.js'), 'utf8'), context);
  context.setupSidebarResize(() => { resized++; });
  return {
    layout, handle, captures, values, windowEvents, resized: () => resized,
    fire(type, event = {}) { events[type]({ preventDefault() {}, button: 0, pointerId: 1, ...event }); }
  };
}

test('sidebar drag grows leftward, clamps to 300px minimum and available space, and notifies the map', () => {
  const ui = setup();
  assert.equal(ui.values['--right-sidebar-width'], '300px');
  assert.equal(ui.handle.attributes['aria-valuemin'], '300');
  assert.equal(ui.handle.attributes['aria-valuemax'], '700');
  ui.fire('pointerdown', { clientX: 900 });
  assert.ok(ui.captures.has(1));
  ui.fire('pointermove', { clientX: 700 });
  assert.equal(ui.values['--right-sidebar-width'], '500px');
  assert.equal(ui.handle.attributes['aria-valuenow'], '500');
  ui.fire('pointermove', { clientX: -100 });
  assert.equal(ui.values['--right-sidebar-width'], '700px');
  ui.fire('pointermove', { clientX: 1400 });
  assert.equal(ui.values['--right-sidebar-width'], '300px');
  ui.fire('pointerup');
  assert.equal(ui.captures.size, 0);
  ui.fire('pointermove', { clientX: 0 });
  assert.equal(ui.values['--right-sidebar-width'], '300px');
  assert.equal(ui.resized(), 4);
});

test('keyboard resizing and viewport changes maintain accessible bounds', () => {
  const ui = setup();
  ui.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(ui.values['--right-sidebar-width'], '320px');
  ui.fire('keydown', { key: 'ArrowRight' });
  assert.equal(ui.values['--right-sidebar-width'], '300px');
  ui.fire('keydown', { key: 'End' });
  assert.equal(ui.values['--right-sidebar-width'], '700px');
  ui.layout.clientWidth = 850;
  ui.windowEvents.resize();
  assert.equal(ui.values['--right-sidebar-width'], '350px');
  assert.equal(ui.handle.attributes['aria-valuemax'], '350');
  ui.fire('keydown', { key: 'Home' });
  assert.equal(ui.values['--right-sidebar-width'], '300px');
  ui.layout.clientWidth = 700;
  ui.windowEvents.resize();
  assert.equal(ui.handle.attributes['aria-valuemax'], '300');
});

test('pointer cancellation, capture loss, and unrelated pointers do not leave resizing active', () => {
  const ui = setup();
  ui.fire('pointerdown', { button: 2, clientX: 900 });
  assert.equal(ui.captures.size, 0);
  for (const finish of ['pointercancel', 'lostpointercapture']) {
    ui.fire('pointerdown', { clientX: 900 });
    ui.fire('pointermove', { pointerId: 2, clientX: 100 });
    assert.equal(ui.values['--right-sidebar-width'], '300px');
    ui.fire(finish);
    ui.fire('pointermove', { clientX: 500 });
    assert.equal(ui.values['--right-sidebar-width'], '300px');
    assert.equal(ui.captures.size, 0);
  }
});
