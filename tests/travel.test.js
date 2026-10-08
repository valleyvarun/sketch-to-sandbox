const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RailRouting = require('../routing.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(root, 'datasets',
  'Bengaluru_metro_suburban_rail_upgraded.geojson'), 'utf8'));
const stations = data.features.filter(feature => feature.geometry.type === 'Point');

function addListener(events, event, fn) {
  if (!events[event]) {
    const listeners = new Set();
    events[event] = value => listeners.forEach(listener => listener(value));
    events[event].listeners = listeners;
  }
  events[event].listeners.add(fn);
}

class Element {
  constructor() {
    this.value = '';
    this.checked = true;
    this.disabled = true;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.events = {};
    this.hidden = true;
  }
  addEventListener(event, fn) { addListener(this.events, event, fn); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  appendChild(child) { this.children.push(child); }
  removeChild(child) {
    const index = this.children.indexOf(child);
    assert.notEqual(index, -1);
    this.children.splice(index, 1);
  }
  replaceChildren() { this.children = []; }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  getBoundingClientRect() { return { left: 12, top: 150, bottom: 186, width: 140 }; }
  scrollIntoView() {}
  focus() { this.events.focus?.({ target: this }); }
  fire(event, values = {}) { this.events[event]({ target: this, preventDefault() {}, ...values }); }
}

async function setup({ failFetch = false, beforeLoad = () => {}, networkData = data } = {}) {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const elements = Object.fromEntries(ids.map(id => {
    const element = new Element();
    element.id = id;
    return [id, element];
  }));
  const documentEvents = {};
  elements.autoplayYears.appendChild(new Element());
  const timers = new Map();
  let nextTimer = 0;
  let elapsed = 0;
  function advanceTime(milliseconds) {
    elapsed += milliseconds;
    for (const timer of timers.values()) {
      while (timer.next <= elapsed) {
        timer.next += timer.delay;
        timer.callback();
      }
    }
  }
  const errors = [];
  const markers = [];
  const popups = [];
  class FakeMap {
    constructor() {
      this.layers = { 'transit-label': {
        id: 'transit-label', type: 'symbol', 'source-layer': 'transit_stop', layout: {}
      } };
      this.sources = {};
      this.events = {};
      this.canvas = new Element();
      this.rendered = [];
    }
    addControl() {}
    on(event, fn) { this.events[event] = fn; }
    addSource(id, source) {
      this.sources[id] = { ...source, setData(value) { this.data = value; } };
    }
    getSource(id) { return this.sources[id]; }
    getStyle() { return { layers: Object.values(this.layers) }; }
    addLayer(layer) { this.layers[layer.id] = structuredClone(layer); }
    setLayoutProperty(id, key, value) { this.layers[id].layout[key] = value; }
    getLayoutProperty(id, key) { return this.layers[id].layout[key]; }
    setPaintProperty(id, key, value) { this.layers[id].paint[key] = value; }
    setFilter(id, filter) { this.layers[id].filter = filter; }
    getCanvas() { return this.canvas; }
    queryRenderedFeatures(box, options) {
      assert.deepEqual(Array.from(options.layers), ['rail-stations']);
      return this.rendered;
    }
    project(coordinates) { return { x: coordinates[0], y: coordinates[1] }; }
    fitBounds(bounds) { this.bounds = bounds; }
  }
  const context = {
    RailRouting,
    setInterval(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay, next: elapsed + delay });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    console: { error(...args) { errors.push(args); } },
    document: {
      getElementById(id) { assert.ok(elements[id], `Missing HTML control ${id}`); return elements[id]; },
      createElement(tagName) {
        const element = new Element();
        element.tagName = tagName;
        return element;
      },
      addEventListener(event, fn) { addListener(documentEvents, event, fn); },
      removeEventListener(event, fn) { documentEvents[event]?.listeners.delete(fn); }
    },
    window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    fetch: async url => {
      assert.equal(url, './datasets/Bengaluru_metro_suburban_rail_upgraded.geojson');
      return { ok: !failFetch, status: 404, json: async () => networkData };
    },
    mapboxgl: {
      Map: FakeMap,
      NavigationControl: class {},
      Popup: class {
        constructor(options) { this.options = options; popups.push(this); }
        setLngLat(coordinates) { this.coordinates = coordinates; return this; }
        setDOMContent(content) { this.content = content; return this; }
        addTo() { return this; }
        remove() { this.removed = true; }
      },
      Marker: class {
        constructor({ element }) { this.element = element; markers.push(this); }
        setLngLat(coordinates) { this.coordinates = coordinates; return this; }
        addTo() { return this; }
        getElement() { return this.element; }
        remove() { this.removed = true; }
      },
      LngLatBounds: class { constructor() { this.points = []; } extend(p) { this.points.push(p); } }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'travel-info.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'sidebar-resize.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'station-search.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'construction.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'script.js'), 'utf8'), context);
  const map = context.initMap('test-token');
  beforeLoad(elements);
  map.events.load();
  await new Promise(resolve => setImmediate(resolve));
  function choose(field, id) {
    const station = stations.find(feature => feature.properties.id === id);
    elements[field].value = '';
    elements[field].fire('focus');
    const list = field === 'fromStation' ? elements.fromSuggestions : elements.toSuggestions;
    const option = list.children.find(option =>
      option.textContent === `${station.properties.name} [${id}]` ||
      option.textContent === station.properties.name);
    assert.ok(option, `Station ${id} has a suggestion`);
    option.fire('click');
  }
  return { elements, map, markers, popups, errors, documentEvents, choose, timers, advanceTime };
}

function evaluate(expression, feature) {
  if (!Array.isArray(expression)) return expression;
  const [op, ...args] = expression;
  switch (op) {
    case 'all': return args.every(arg => evaluate(arg, feature));
    case '==': return evaluate(args[0], feature) === evaluate(args[1], feature);
    case 'get': return feature.properties[args[0]];
    case 'geometry-type': return feature.geometry.type;
    case 'literal': return args[0];
    case 'in': return evaluate(args[1], feature).includes(evaluate(args[0], feature));
    case 'case': return evaluate(args[0], feature) ? evaluate(args[1], feature) : evaluate(args[2], feature);
    default: throw new Error(`Unknown filter ${op}`);
  }
}

function descendant(element, id) {
  if (element.id === id) return element;
  for (const child of element.children) {
    const found = descendant(child, id);
    if (found) return found;
  }
}

function assertDarker(actual, original) {
  assert.match(actual, /^#[0-9a-f]{6}$/i);
  for (const offset of [1, 3, 5]) {
    assert.equal(parseInt(actual.slice(offset, offset + 2), 16),
      Math.round(parseInt(original.slice(offset, offset + 2), 16) / 2));
  }
}

function assertBaseLineColor(actual, feature) {
  if (feature.properties.constructed) assert.equal(actual, feature.properties.stroke);
  else assertDarker(actual, feature.properties.stroke);
}

function phaseControls(elements, index) {
  const field = name => descendant(elements.phaseList, `phase-${index}-${name}`);
  return {
    number: field('number'), from: field('from'), to: field('to'), line: field('line'),
    pickFrom: field('from-pick'), pickTo: field('to-pick'),
    suggestions(which) {
      return field(`${which}-suggestions`).children.filter(option =>
        option.attributes.role === 'option').map(option => option.id.split('-option-')[1]);
    },
    choose(which, id) {
      const input = field(which);
      input.value = '';
      input.fire('focus');
      const list = field(`${which}-suggestions`);
      const station = stations.find(station => station.properties.id === id);
      const option = list.children.find(option =>
        option.textContent === `${station.properties.name} [${id}]` ||
        option.textContent === station.properties.name);
      assert.ok(option, `${id} is a suggestion for ${which}`);
      option.fire('click');
    }
  };
}

test('Add Phase enters final-plan construction mode and clears and disables Travel', async () => {
  const { elements: e, map, choose, markers, timers } = await setup();
  choose('fromStation', 'ST001');
  choose('toStation', 'ST250');
  e.travelForm.fire('submit');
  e.autoplayYears.fire('click');
  e.addPhase.fire('click');
  assert.equal(timers.size, 0);
  assert.equal(e.mapYear.textContent, 'final plan');
  assert.equal(e.fromStation.value, '');
  assert.equal(e.toStation.value, '');
  assert.equal(e.fromStation.disabled, true);
  assert.equal(e.toStation.disabled, true);
  assert.equal(e.runTravel.disabled, true);
  assert.equal(e.travelForm.attributes['aria-disabled'], 'true');
  assert.equal(e.autoplayYears.disabled, true);
  assert.equal(e.previousYear.disabled, true);
  assert.equal(e.constructionMode.attributes['aria-pressed'], 'true');
  assert.equal(map.sources['travel-path'].data.features.length, 0);
  assert.ok(markers.every(marker => marker.removed));
  const phase = phaseControls(e, 1);
  assert.equal(phase.number.value, '3');
  assert.equal(phase.to.disabled, true);
  assert.equal(e.addPhase.hidden, true);
  assert.equal(e.buildPlan.disabled, true);
  const features = map.sources['rail-network'].data.features;
  const opened = features.find(feature => feature.properties.route_id === 'purple');
  const future = features.find(feature => feature.properties.route_id === 'pink');
  assert.equal(opened.properties.planning_color, opened.properties.stroke);
  assertDarker(future.properties.planning_color, future.properties.stroke);
  for (const feature of features) {
    if (feature.geometry.type === 'Point') {
      const year = feature.properties.station_opening_year;
      const isOpen = Number.isInteger(year) && year <= 2026;
      const route = data.features.find(route => route.properties.feature_type === 'route' &&
        route.properties.station_ids_in_order.includes(feature.properties.id));
      assert.equal(evaluate(map.layers['rail-stations'].paint['circle-color'], feature),
        isOpen ? '#000000' : route.properties.stroke);
    } else {
      assertBaseLineColor(evaluate(map.layers['rail-routes'].paint['line-color'], feature), feature);
    }
  }
  assert.ok(features.every(feature => /^#[0-9a-f]{6}$|^rgb\(\d+,\d+,\d+\)$/i.test(feature.properties.planning_color)));
});

test('construction darkens only unassigned unopened segments while opened segments and phases retain their colors', async () => {
  const networkData = structuredClone(data);
  for (const id of ['ST101', 'ST102']) {
    const station = networkData.features.find(feature => feature.properties.id === id);
    station.properties.station_opening_year = 2026;
    station.properties.station_line_history.find(history =>
      history.route_id === 'blue').station_opening_year = 2026;
  }
  const { elements: e, map } = await setup({ networkData });
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST100');
  first.choose('to', 'ST106');
  const overlays = () => map.sources['construction-path'].data.features;
  function assertPhaseColors() {
    for (const feature of overlays()) {
      const color = evaluate(map.layers[`construction-${feature.properties.system}`].paint['line-color'], feature);
      assert.equal(color, feature.properties.stroke);
    }
  }
  assert.equal(overlays().filter(feature => feature.properties.constructed).length, 1);
  assert.equal(overlays().filter(feature => !feature.properties.constructed).length, 5);
  assertPhaseColors();
  for (const feature of map.sources['rail-network'].data.features.filter(feature =>
    feature.geometry.type === 'LineString')) {
    assertBaseLineColor(evaluate(map.layers['rail-routes'].paint['line-color'], feature), feature);
  }
  e.buildPlan.fire('click');
  const removeBlue = e.builtPlan.children[1].children.at(-1);
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  second.choose('from', 'ST182');
  second.choose('to', 'ST183');
  assert.equal(overlays().length, 7);
  assertPhaseColors();
  assert.equal(map.layers['construction-suburban'].paint['line-width'], 3);
  assert.deepEqual(map.layers['construction-suburban'].paint['line-dasharray'], [3, 2]);
  e.clearPlan.fire('click');
  assert.equal(overlays().length, 6);
  assertPhaseColors();
  second.choose('from', 'ST182');
  second.choose('to', 'ST183');
  e.buildPlan.fire('click');
  removeBlue.fire('click');
  assert.equal(overlays().length, 1);
  assertPhaseColors();
  for (const feature of map.sources['rail-network'].data.features.filter(feature =>
    feature.properties.route_id === 'blue')) {
    assertBaseLineColor(evaluate(map.layers['rail-routes'].paint['line-color'], feature), feature);
  }
  const openedStation = map.sources['rail-network'].data.features.find(feature => feature.properties.id === 'ST101');
  assert.equal(evaluate(map.layers['rail-stations'].paint['circle-color'], openedStation), '#000000');
  e.travelMode.fire('click');
  assert.deepEqual(Array.from(map.layers['rail-routes'].paint['line-color']), ['get', 'stroke']);
  assert.equal(map.layers['construction-suburban'].layout.visibility, 'none');
});

test('opened rail sections stay thick in construction mode regardless of line focus and restore in Travel', async () => {
  const networkData = structuredClone(data);
  for (const id of ['ST181', 'ST182']) {
    const station = networkData.features.find(feature => feature.properties.id === id);
    station.properties.station_opening_year = 2026;
    station.properties.station_line_history.find(history =>
      history.route_id === 'sampige').station_opening_year = 2026;
  }
  const { elements: e, map } = await setup({ networkData });
  e.addPhase.fire('click');
  const features = map.sources['rail-network'].data.features.filter(feature =>
    feature.geometry.type === 'LineString' && feature.properties.feature_type === 'route');
  assert.ok(features.some(feature => feature.properties.system === 'suburban' && feature.properties.constructed));
  function checkWidths(focusedLine) {
    for (const feature of features) {
      const metro = feature.properties.system === 'metro';
      const layer = metro ? 'rail-routes' : 'suburban-routes';
      const expected = feature.properties.constructed ? (metro ? 6 : 3) :
        (!focusedLine || feature.properties.route_id === focusedLine) ? (metro ? 3 : 1) : 0.75;
      assert.equal(evaluate(map.layers[layer].paint['line-width'], feature), expected);
      assertBaseLineColor(evaluate(map.layers[layer].paint['line-color'], feature), feature);
    }
  }
  checkWidths(null);
  const phase = phaseControls(e, 1);
  phase.choose('from', 'ST084');
  checkWidths('pink');
  phase.choose('to', 'ST088');
  assert.equal(map.layers['construction-metro'].paint['line-width'], 6);
  e.clearPlan.fire('click');
  checkWidths(null);
  e.travelMode.fire('click');
  assert.equal(map.layers['rail-routes'].paint['line-width'], 3);
  assert.equal(map.layers['suburban-routes'].paint['line-width'], 1);
});

test('construction limits the second search to one line and asks for an interchange line', async () => {
  const { elements: e, map } = await setup();
  e.addPhase.fire('click');
  const phase = phaseControls(e, 1);
  phase.choose('from', 'ST087');
  assert.equal(phase.line.hidden, false);
  assert.deepEqual(phase.line.children.map(option => option.value), ['', 'pink', 'orange']);
  assert.equal(phase.to.disabled, true);
  phase.line.value = 'orange';
  phase.line.fire('change');
  assert.equal(phase.to.disabled, false);
  phase.to.fire('focus');
  const options = descendant(e.phaseList, 'phase-1-to-suggestions').children;
  const orange = data.features.find(feature => feature.properties.route_id === 'orange' && feature.properties.feature_type === 'route');
  const unopened = stations.filter(station => !Number.isInteger(station.properties.station_opening_year) ||
    station.properties.station_opening_year > 2026);
  assert.equal(options.length, unopened.filter(station =>
    orange.properties.station_ids_in_order.includes(station.properties.id)).length - 1);
  assert.equal(map.layers['rail-routes'].paint['line-width'][3][1][2], 'orange');
  phase.choose('to', 'ST145');
  assert.equal(e.buildPlan.disabled, false);
  assert.equal(e.addPhase.hidden, true);
  assert.ok(map.sources['construction-path'].data.features.every(feature => feature.properties.route_id === 'orange'));
  assert.equal(map.layers['construction-metro'].paint['line-width'], 6);
  assert.equal(map.layers['rail-stations'].paint['circle-radius'][2], 6);
  const orangeFeature = map.sources['rail-network'].data.features.find(feature => feature.properties.route_id === 'orange');
  const purpleFeature = map.sources['rail-network'].data.features.find(feature => feature.properties.route_id === 'purple');
  assert.equal(evaluate(map.layers['rail-routes'].paint['line-color'], orangeFeature), orangeFeature.properties.planning_color);
  assert.equal(evaluate(map.layers['rail-routes'].paint['line-color'], purpleFeature), purpleFeature.properties.stroke);
  const futureFeature = map.sources['rail-network'].data.features.find(feature => feature.properties.route_id === 'pink');
  assertDarker(evaluate(map.layers['rail-routes'].paint['line-color'], futureFeature), futureFeature.properties.stroke);
  for (const feature of map.sources['construction-path'].data.features) {
    assert.equal(evaluate(map.layers['construction-metro'].paint['line-color'], feature), feature.properties.planning_color);
  }
  for (const station of map.sources['rail-network'].data.features.filter(feature =>
    feature.geometry.type === 'Point' && feature.properties.constructed)) {
    assert.equal(evaluate(map.layers['rail-stations'].paint['circle-color'], station), '#000000');
  }
  const selectedStation = map.sources['rail-network'].data.features.find(feature => feature.properties.id === 'ST145');
  assert.equal(evaluate(map.layers['rail-stations'].paint['circle-radius'], selectedStation), 6);
  for (const invalid of ['', '0', '-1', '1.5']) {
    phase.number.value = invalid;
    phase.number.fire('input');
    assert.equal(e.buildPlan.disabled, true);
    assert.equal(e.addPhase.hidden, true);
  }
  phase.number.value = '3';
  phase.number.fire('input');
  phase.choose('from', 'ST084');
  assert.equal(phase.to.value, '');
  assert.equal(phase.line.value, 'pink');
  assert.equal(phase.line.hidden, true);
  assert.equal(e.buildPlan.disabled, true);
  phase.to.value = 'KIAL Terminals [ST129]';
  phase.to.fire('input');
  assert.equal(e.buildPlan.disabled, true);
  assert.equal(map.sources['construction-path'].data.features.length, 0);
});

test('Build appends one phase at a time, resets the editor, and preserves saved and draft work across modes', async () => {
  const { elements: e, map, choose, documentEvents } = await setup();
  const initialListeners = documentEvents.pointerdown.listeners.size;
  e.previousYear.fire('click');
  e.showSuburban.checked = false;
  e.showSuburban.fire('change');
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST100');
  first.choose('to', 'ST106');
  first.number.value = '7';
  first.number.fire('input');
  assert.equal(e.addPhase.hidden, true);
  e.addPhase.fire('click');
  assert.equal(e.phaseList.children.length, 1, 'cannot add another draft before Build');
  e.buildPlan.fire('click');
  assert.equal(e.phaseList.children.length, 0);
  assert.equal(e.addPhase.hidden, false);
  assert.equal(e.buildPlan.disabled, true);
  assert.equal(e.clearPlan.disabled, true);
  assert.equal(documentEvents.pointerdown.listeners.size, initialListeners);
  const published = e.builtPlan.children[1];
  const firstFeatures = structuredClone(map.sources['construction-path'].data.features);
  assert.equal(firstFeatures.length, 6);
  e.buildPlan.fire('click');
  assert.equal(e.builtPlan.children.length, 2, 'repeated Build does not duplicate a phase');
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  assert.equal(second.number.value, '8');
  second.choose('from', 'ST084');
  second.choose('to', 'ST088');
  second.number.value = '7';
  second.number.fire('input');
  assert.equal(e.buildPlan.disabled, true);
  assert.match(e.constructionStatus.textContent, /different positive whole/);
  e.buildPlan.fire('click');
  assert.equal(e.builtPlan.children.length, 2, 'duplicate numbers cannot be saved');
  second.number.value = '8';
  second.number.fire('input');
  e.buildPlan.fire('click');
  assert.equal(e.phaseList.children.length, 0);
  assert.equal(e.builtPlan.children[0].textContent, '2 phases built.');
  assert.equal(e.builtPlan.children.length, 3);
  assert.equal(e.builtPlan.children[1].children[0].textContent, 'Phase 7');
  assert.equal(e.builtPlan.children[2].children[0].textContent, 'Phase 8');
  assert.match(e.builtPlan.children[1].children[1].textContent, /Metro - Blue/);
  assert.match(e.builtPlan.children[2].children[1].textContent, /Metro - Pink/);
  assert.equal(e.builtPlan.children[1].children[2].children.length, 7);
  assert.equal(e.builtPlan.children[1], published);
  assert.deepEqual(structuredClone(map.sources['construction-path'].data.features.slice(0, 6)), firstFeatures);
  const savedFeatures = structuredClone(map.sources['construction-path'].data.features);
  assert.equal(map.layers['rail-routes'].paint['line-width'][3][1], true);
  e.addPhase.fire('click');
  const third = phaseControls(e, 3);
  assert.equal(third.number.value, '9');
  third.choose('from', 'ST153');
  e.travelMode.fire('click');
  assert.equal(e.fromStation.disabled, false);
  assert.equal(e.mapYear.textContent, '2026');
  assert.equal(e.showSuburban.checked, false);
  assert.equal(map.layers['construction-metro'].layout.visibility, 'none');
  assert.equal(map.layers['rail-stations'].paint['circle-radius'], 4);
  assert.deepEqual(Array.from(map.layers['rail-routes'].paint['line-color']), ['get', 'stroke']);
  assert.equal(e.phaseList.children[0].disabled, true);
  choose('fromStation', 'ST001');
  choose('toStation', 'ST002');
  e.travelForm.fire('submit');
  assert.ok(map.sources['travel-path'].data.features.length > 0);
  e.constructionMode.fire('click');
  assert.equal(e.phaseList.children.length, 1);
  assert.equal(third.number.value, '9');
  assert.notEqual(third.from.value, '');
  assert.equal(e.builtPlan.children[1], published);
  assert.equal(e.phaseList.children[0].disabled, false);
  assert.equal(e.fromStation.value, '');
  assert.deepEqual(structuredClone(map.sources['construction-path'].data.features), savedFeatures);
  third.choose('to', 'ST156');
  third.number.value = '10';
  third.number.fire('input');
  assert.equal(e.builtPlan.children[1], published);
  e.buildPlan.fire('click');
  assert.equal(e.builtPlan.children[1].children[0].textContent, 'Phase 7');
  assert.equal(e.builtPlan.children[3].children[0].textContent, 'Phase 10');
  assert.equal(e.builtPlan.children[0].textContent, '3 phases built.');
  assert.equal(e.phaseList.children.length, 0);
  assert.equal(documentEvents.pointerdown.listeners.size, initialListeners);
});

test('deleting a saved phase preserves other phases and the draft and releases its stations', async () => {
  const { elements: e, map } = await setup();
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST100');
  first.choose('to', 'ST106');
  e.buildPlan.fire('click');
  const firstSection = e.builtPlan.children[1];
  const removeFirst = firstSection.children.at(-1);
  assert.equal(removeFirst.textContent, 'Clear');
  assert.equal(removeFirst.attributes['aria-label'], 'Delete Phase 3');
  assert.equal(removeFirst.disabled, false);
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  second.choose('from', 'ST084');
  second.choose('to', 'ST088');
  e.buildPlan.fire('click');
  const secondSection = e.builtPlan.children[2];
  e.addPhase.fire('click');
  const draft = phaseControls(e, 3);
  draft.choose('from', 'ST153');
  draft.choose('to', 'ST156');
  const draftValues = [draft.number.value, draft.from.value, draft.to.value];
  draft.pickTo.fire('click');
  draft.to.fire('focus');
  removeFirst.fire('click');
  assert.equal(map.canvas.style.cursor, '');
  assert.equal(draft.pickTo.attributes['aria-pressed'], 'false');
  assert.equal(e.builtPlan.children.length, 2);
  assert.equal(e.builtPlan.children[0].textContent, '1 phase built.');
  assert.equal(e.builtPlan.children[1], secondSection);
  assert.equal(secondSection.children[0].textContent, 'Phase 4');
  assert.equal(e.phaseList.children.length, 1);
  assert.deepEqual([draft.number.value, draft.from.value, draft.to.value], draftValues);
  assert.equal(e.buildPlan.disabled, false);
  assert.match(e.constructionStatus.textContent, /Phase 3 deleted/);
  const highlighted = map.sources['construction-path'].data.features;
  assert.ok(!highlighted.some(feature => feature.properties.route_id === 'blue'));
  assert.ok(highlighted.some(feature => feature.properties.route_id === 'pink'));
  assert.ok(highlighted.some(feature => feature.properties.route_id === 'red'));
  const removedStation = stations.find(station => station.properties.id === 'ST104');
  assert.equal(evaluate(map.layers['rail-stations'].paint['circle-radius'], removedStation), 4);
  draft.to.value = '';
  draft.to.fire('input');
  assert.ok(draft.suggestions('to').includes('ST103'), 'released interchange returns to its other line');
  draft.from.value = '';
  draft.from.fire('input');
  assert.ok(draft.suggestions('from').includes('ST104'));
  assert.ok(!draft.suggestions('from').includes('ST085'), 'remaining saved phase stays excluded');
  assert.ok(!draft.suggestions('from').includes('ST001'), 'opened stations stay excluded');
  removeFirst.fire('click');
  assert.equal(e.builtPlan.children[1], secondSection, 'a repeated click cannot delete another phase');
});

test('individual deletion retains shared highlights, is disabled in Travel, and can empty and restart the plan', async () => {
  const { elements: e, map, documentEvents } = await setup();
  const initialListeners = documentEvents.pointerdown.listeners.size;
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST103');
  first.line.value = 'blue';
  first.line.fire('change');
  first.choose('to', 'ST106');
  e.buildPlan.fire('click');
  const removeFirst = e.builtPlan.children[1].children.at(-1);
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  second.choose('from', 'ST100');
  second.choose('to', 'ST103');
  e.buildPlan.fire('click');
  const removeSecond = e.builtPlan.children[2].children.at(-1);
  e.travelMode.fire('click');
  assert.equal(removeFirst.disabled, true);
  assert.equal(removeSecond.disabled, true);
  removeFirst.fire('click');
  assert.equal(e.builtPlan.children.length, 3);
  e.constructionMode.fire('click');
  assert.equal(removeFirst.disabled, false);
  removeFirst.fire('click');
  assert.equal(map.sources['construction-path'].data.features.length, 3);
  const sharedStation = stations.find(station => station.properties.id === 'ST103');
  assert.equal(evaluate(map.layers['rail-stations'].paint['circle-radius'], sharedStation), 6);
  e.addPhase.fire('click');
  const draft = phaseControls(e, 2);
  assert.equal(draft.number.value, '5');
  assert.ok(!draft.suggestions('from').includes('ST102'));
  removeSecond.fire('click');
  assert.ok(draft.suggestions('from').includes('ST102'), 'open dropdown updates when last covering phase is removed');
  assert.equal(e.builtPlan.children[0].textContent, 'No plan built yet.');
  assert.equal(map.sources['construction-path'].data.features.length, 0);
  assert.equal(e.clearPlan.disabled, false, 'the empty draft can still be cleared');
  draft.choose('from', 'ST100');
  draft.choose('to', 'ST106');
  e.buildPlan.fire('click');
  assert.equal(e.builtPlan.children[1].children[0].textContent, 'Phase 5');
  e.builtPlan.children[1].children.at(-1).fire('click');
  assert.equal(e.builtPlan.children.length, 1);
  assert.equal(e.builtPlan.children[0].textContent, 'No plan built yet.');
  assert.equal(e.phaseList.children.length, 0);
  assert.equal(e.addPhase.hidden, false);
  assert.equal(e.buildPlan.disabled, true);
  assert.equal(e.clearPlan.disabled, true);
  assert.equal(documentEvents.pointerdown.listeners.size, initialListeners);
  e.addPhase.fire('click');
  const restarted = phaseControls(e, 1);
  assert.equal(restarted.number.value, '3');
  restarted.choose('from', 'ST100');
  restarted.choose('to', 'ST106');
  e.buildPlan.fire('click');
  assert.equal(e.builtPlan.children.length, 2);
  assert.equal(e.builtPlan.children[1].children[0].textContent, 'Phase 3');
});

test('construction searches exclude opened stations and reject manually entered opened endpoints', async () => {
  const { elements: e, map } = await setup();
  e.addPhase.fire('click');
  const phase = phaseControls(e, 1);
  const unopened = stations.filter(station => !Number.isInteger(station.properties.station_opening_year) ||
    station.properties.station_opening_year > 2026).map(station => station.properties.id);
  assert.equal(unopened.length, 167);
  assert.deepEqual(phase.suggestions('from').sort(), unopened.sort());
  phase.from.value = stations.find(station => station.properties.id === 'ST001').properties.name;
  phase.from.fire('input');
  assert.equal(phase.to.disabled, true);
  assert.deepEqual(phase.suggestions('from'), []);
  phase.choose('from', 'ST084');
  phase.to.fire('focus');
  assert.ok(!phase.suggestions('to').includes('ST070'));
  assert.ok(!phase.suggestions('to').includes('ST019'));
  phase.to.value = stations.find(station => station.properties.id === 'ST070').properties.name;
  phase.to.fire('input');
  assert.equal(e.buildPlan.disabled, true);
  e.buildPlan.fire('click');
  assert.match(e.constructionStatus.textContent, /Complete every phase/);
  assert.equal(map.sources['construction-path'].data.features.length, 0);
});

test('new phase searches exclude saved stations and draft edits leave the saved plan unchanged', async () => {
  const { elements: e, map } = await setup();
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST100');
  first.choose('to', 'ST106');
  e.buildPlan.fire('click');
  const saved = e.builtPlan.children[1];
  const savedFeatures = structuredClone(map.sources['construction-path'].data.features);
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  for (let id = 101; id <= 105; id++) {
    assert.ok(!second.suggestions('from').includes(`ST${id}`));
  }
  assert.ok(second.suggestions('from').includes('ST100'));
  assert.ok(second.suggestions('from').includes('ST106'));
  second.choose('from', 'ST108');
  second.to.fire('focus');
  assert.ok(!second.suggestions('to').includes('ST103'));
  second.to.value = stations.find(station => station.properties.id === 'ST103').properties.name;
  second.to.fire('input');
  assert.equal(e.buildPlan.disabled, true);
  second.choose('to', 'ST110');
  second.number.value = '1';
  second.number.fire('input');
  second.from.value = '';
  second.from.fire('focus');
  assert.ok(!second.suggestions('from').includes('ST103'), 'saved stations remain excluded regardless of phase number');
  second.choose('from', 'ST108');
  assert.equal(second.to.value, '');
  assert.equal(e.buildPlan.disabled, true);
  assert.equal(e.builtPlan.children[1], saved);
  assert.equal(e.builtPlan.children[0].textContent, '1 phase built.');
  assert.deepEqual(structuredClone(map.sources['construction-path'].data.features), savedFeatures);
  assert.equal(second.to.disabled, false);
  second.choose('to', 'ST110');
  e.buildPlan.fire('click');
  assert.equal(e.builtPlan.children[2].children[0].textContent, 'Phase 1');
  e.clearPlan.fire('click');
  assert.equal(e.builtPlan.children.length, 3, 'Clear cannot remove saved phases without a draft');
  e.addPhase.fire('click');
  assert.ok(!phaseControls(e, 3).suggestions('from').includes('ST103'));
});

test('new phases can connect to either saved endpoint but cannot cross saved stations in either direction', async () => {
  for (const [start, end] of [['ST104', 'ST106'], ['ST106', 'ST104']]) {
    const { elements: e, map } = await setup();
    e.addPhase.fire('click');
    const first = phaseControls(e, 1);
    first.choose('from', start);
    first.choose('to', end);
    e.buildPlan.fire('click');
    e.addPhase.fire('click');
    const second = phaseControls(e, 2);
    assert.ok(second.suggestions('from').includes('ST104'));
    assert.ok(second.suggestions('from').includes('ST106'));
    assert.ok(!second.suggestions('from').includes('ST105'));
    second.choose('from', 'ST100');
    second.to.fire('focus');
    assert.deepEqual(second.suggestions('to').sort(), ['ST101', 'ST102', 'ST103', 'ST104']);
    for (const id of ['ST105', 'ST106', 'ST108']) {
      second.to.value = stations.find(station => station.properties.id === id).properties.name;
      second.to.fire('input');
      assert.equal(e.buildPlan.disabled, true, `${id} overlaps the saved phase from the left`);
      e.buildPlan.fire('click');
      assert.equal(e.builtPlan.children.length, 2);
      assert.match(e.constructionStatus.textContent, /shared endpoint/);
    }
    second.choose('from', 'ST108');
    second.to.fire('focus');
    assert.ok(second.suggestions('to').includes('ST106'));
    assert.ok(!second.suggestions('to').includes('ST104'));
    assert.ok(!second.suggestions('to').includes('ST100'));
    second.choose('from', 'ST104');
    second.to.fire('focus');
    assert.deepEqual(second.suggestions('to').sort(), ['ST100', 'ST101', 'ST102', 'ST103']);
    second.choose('to', 'ST100');
    e.buildPlan.fire('click');
    e.addPhase.fire('click');
    const third = phaseControls(e, 3);
    third.choose('from', 'ST106');
    third.to.fire('focus');
    assert.ok(!third.suggestions('to').includes('ST104'));
    third.choose('to', 'ST108');
    e.buildPlan.fire('click');
    assert.equal(e.builtPlan.children[0].textContent, '3 phases built.');
    const features = map.sources['construction-path'].data.features;
    assert.equal(features.length, 8);
    const segments = features.map(feature => JSON.stringify(
      [...feature.geometry.coordinates].map(point => JSON.stringify(point)).sort()));
    assert.equal(new Set(segments).size, 8, 'connecting phases share no rail segments');
  }
});

test('saved interchange endpoints allow connections on another line but cannot be crossed', async () => {
  const { elements: e } = await setup();
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST103');
  first.line.value = 'blue';
  first.line.fire('change');
  first.choose('to', 'ST106');
  e.buildPlan.fire('click');
  const removeSaved = e.builtPlan.children[1].children.at(-1);
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  second.choose('from', 'ST103');
  assert.equal(second.line.hidden, false);
  second.line.value = 'red';
  second.line.fire('change');
  second.choose('to', 'ST170');
  assert.equal(e.buildPlan.disabled, false);
  second.choose('from', 'ST153');
  second.to.fire('focus');
  assert.ok(second.suggestions('to').includes('ST103'));
  assert.ok(!second.suggestions('to').includes('ST170'));
  second.to.value = stations.find(station => station.properties.id === 'ST170').properties.name;
  second.to.fire('input');
  assert.equal(e.buildPlan.disabled, true);
  removeSaved.fire('click');
  second.to.value = '';
  second.to.fire('input');
  assert.ok(second.suggestions('to').includes('ST103'));
  assert.ok(second.suggestions('to').includes('ST170'), 'deleting the saved phase releases crossing paths');
  second.choose('to', 'ST170');
  assert.equal(e.buildPlan.disabled, false);
});

test('saved single-segment endpoints remain selectable but overlapping track is blocked in both directions', async () => {
  const { elements: e, map } = await setup();
  function click(id) {
    const station = stations.find(station => station.properties.id === id);
    map.rendered = [station];
    map.events.click({ point: map.project(station.geometry.coordinates) });
  }
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST104');
  first.choose('to', 'ST105');
  e.buildPlan.fire('click');
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  for (const [from, to] of [['ST104', 'ST105'], ['ST105', 'ST104']]) {
    second.pickFrom.fire('click');
    click(from);
    assert.notEqual(second.from.value, '', 'saved endpoints can be picked as the first station');
    assert.equal(second.pickFrom.attributes['aria-pressed'], 'false');
    second.to.fire('focus');
    assert.ok(!second.suggestions('to').includes(to));
    second.to.value = stations.find(station => station.properties.id === to).properties.name;
    second.to.fire('input');
    assert.equal(e.buildPlan.disabled, true);
    second.to.value = '';
    second.to.fire('input');
    second.pickTo.fire('click');
    click(to);
    assert.equal(second.to.value, '');
    assert.equal(second.pickTo.attributes['aria-pressed'], 'true');
    assert.match(e.constructionStatus.textContent, /not available/);
    e.buildPlan.fire('click');
    assert.equal(e.builtPlan.children.length, 2);
  }
  click('ST106');
  assert.equal(e.buildPlan.disabled, false);
  e.buildPlan.fire('click');
  assert.equal(map.sources['construction-path'].data.features.length, 2);
  e.addPhase.fire('click');
  const third = phaseControls(e, 3);
  assert.ok(third.suggestions('from').includes('ST105'), 'the shared endpoint stays available');
  third.choose('from', 'ST105');
  third.to.fire('focus');
  assert.deepEqual(third.suggestions('to'), [], 'both directions would reuse saved track');
  assert.equal(e.buildPlan.disabled, true);
});

test('construction exclusions accumulate across saved phases and interchange lines', async () => {
  const { elements: e } = await setup();
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST100');
  first.choose('to', 'ST106');
  e.buildPlan.fire('click');
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  second.choose('from', 'ST153');
  second.to.fire('focus');
  assert.ok(!second.suggestions('to').includes('ST103'), 'blue phase excludes shared red interchange');
  second.choose('to', 'ST156');
  e.buildPlan.fire('click');
  e.addPhase.fire('click');
  const third = phaseControls(e, 3);
  for (const id of ['ST103', 'ST154', 'ST155']) {
    assert.ok(!third.suggestions('from').includes(id));
  }
  for (const id of ['ST100', 'ST106', 'ST153', 'ST156']) {
    assert.ok(third.suggestions('from').includes(id));
  }
  third.from.value = stations.find(station => station.properties.id === 'ST103').properties.name;
  third.from.fire('input');
  assert.equal(third.to.disabled, true);
  assert.equal(e.buildPlan.disabled, true);
  assert.equal(e.builtPlan.children.length, 3);
});

test('construction map picking uses dropdown eligibility and selects both endpoints without changing Travel or map styling', async () => {
  const { elements: e, map, popups } = await setup();
  function click(id) {
    const station = stations.find(station => station.properties.id === id);
    map.rendered = [station];
    map.events.click({ point: map.project(station.geometry.coordinates) });
  }
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  assert.equal(first.pickFrom.disabled, false);
  assert.equal(first.pickTo.disabled, true);
  first.pickTo.fire('click');
  assert.notEqual(map.canvas.style.cursor, 'crosshair');
  click('ST001');
  const popup = popups[0];
  first.pickFrom.fire('click');
  assert.equal(popup.removed, true);
  assert.equal(first.pickFrom.attributes['aria-pressed'], 'true');
  assert.equal(map.canvas.style.cursor, 'crosshair');
  assert.equal(descendant(e.phaseList, 'phase-1-from-suggestions').hidden, true);
  map.rendered = [];
  map.events.click({ point: { x: 0, y: 0 } });
  assert.match(e.constructionStatus.textContent, /No station/);
  click('ST001');
  assert.match(e.constructionStatus.textContent, /not available/);
  assert.equal(first.from.value, '');
  assert.equal(first.pickFrom.attributes['aria-pressed'], 'true');
  click('ST087');
  assert.notEqual(first.from.value, '');
  assert.equal(first.line.hidden, false);
  assert.equal(first.pickTo.disabled, true);
  assert.equal(first.pickFrom.attributes['aria-pressed'], 'false');
  assert.equal(map.canvas.style.cursor, '');
  first.line.value = 'pink';
  first.line.fire('change');
  assert.equal(first.pickTo.disabled, false);
  first.pickTo.fire('click');
  for (const id of ['ST100', 'ST087', 'ST070']) {
    click(id);
    assert.equal(first.to.value, '');
    assert.equal(first.pickTo.attributes['aria-pressed'], 'true');
    assert.match(e.constructionStatus.textContent, /not available/);
  }
  click('ST092');
  assert.equal(first.pickTo.attributes['aria-pressed'], 'false');
  assert.equal(e.buildPlan.disabled, false);
  assert.ok(map.sources['construction-path'].data.features.length > 0);
  assert.equal(map.layers['rail-routes'].paint['line-width'][3][1][2], 'pink');
  assert.equal(e.fromStation.value, '');
  assert.equal(e.toStation.value, '');
  assert.equal(popups.length, 1, 'picking does not open station popups');
  e.buildPlan.fire('click');
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  second.pickFrom.fire('click');
  click('ST089');
  assert.equal(second.from.value, '', 'previous phase intermediate stations cannot be picked');
  click('ST093');
  assert.equal(second.pickTo.disabled, false);
  second.pickTo.fire('click');
  click('ST089');
  assert.equal(second.to.value, '', 'previous phase interior stations cannot be picked');
  click('ST092');
  assert.notEqual(second.to.value, '', 'a previous phase endpoint can be picked to connect');
  assert.equal(e.buildPlan.disabled, false);
});

test('construction map picking cancels on toggle, Escape, edits, Build, Clear, and mode switches', async () => {
  const { elements: e, map, documentEvents } = await setup();
  e.addPhase.fire('click');
  const phase = phaseControls(e, 1);
  phase.choose('from', 'ST100');
  phase.choose('to', 'ST106');
  phase.pickFrom.fire('click');
  phase.pickTo.fire('click');
  assert.equal(phase.pickFrom.attributes['aria-pressed'], 'false');
  assert.equal(phase.pickTo.attributes['aria-pressed'], 'true');
  phase.pickTo.fire('click');
  assert.equal(map.canvas.style.cursor, '');
  assert.match(e.constructionStatus.textContent, /cancelled/);
  phase.pickFrom.fire('click');
  documentEvents.keydown({ key: 'Escape' });
  assert.equal(phase.pickFrom.attributes['aria-pressed'], 'false');
  assert.match(e.constructionStatus.textContent, /cancelled/);
  phase.pickFrom.fire('click');
  phase.number.fire('input');
  assert.equal(map.canvas.style.cursor, '');
  phase.pickTo.fire('click');
  e.buildPlan.fire('click');
  assert.equal(map.canvas.style.cursor, '');
  assert.equal(phase.pickTo.attributes['aria-pressed'], 'false');
  e.addPhase.fire('click');
  const next = phaseControls(e, 2);
  next.choose('from', 'ST108');
  next.pickFrom.fire('click');
  e.travelMode.fire('click');
  assert.equal(map.canvas.style.cursor, '');
  assert.equal(next.pickFrom.disabled, true);
  assert.equal(next.pickTo.disabled, true);
  e.constructionMode.fire('click');
  assert.equal(next.pickFrom.disabled, false);
  assert.equal(next.pickTo.disabled, false);
  next.pickTo.fire('click');
  e.clearPlan.fire('click');
  assert.equal(map.canvas.style.cursor, '');
  assert.equal(next.pickTo.attributes['aria-pressed'], 'false');
  assert.equal(e.phaseList.children.length, 1);
  assert.equal(next.from.value, '');
  assert.equal(next.to.value, '');
});

test('suggestions contain point names only, with IDs solely for duplicate names', async () => {
  const { elements: e, choose } = await setup();
  e.fromStation.fire('focus');
  for (const station of stations) {
    const name = station.properties.name;
    const duplicates = stations.filter(other =>
      other.properties.name.toLowerCase() === name.toLowerCase()).length;
    const expected = duplicates > 1 ? `${name} [${station.properties.id}]` : name;
    assert.ok(e.fromSuggestions.children.some(option => option.textContent === expected));
  }
  assert.ok(e.fromSuggestions.children.every(option => option.attributes.role === 'option'));
  assert.ok(!e.fromSuggestions.children.some(option => option.textContent === 'Metro - Purple'));
  choose('toStation', 'ST037');
  e.fromStation.value = '  challaghatta  ';
  e.fromStation.fire('input');
  assert.equal(e.runTravel.disabled, false);
  choose('fromStation', 'ST002');
  assert.equal(e.fromStation.value, 'Kengeri [ST002]');
  assert.equal(e.runTravel.disabled, false);
});

test('station search rejects ambiguous names, invalid text, and identical endpoints', async () => {
  const { elements: e, choose, map } = await setup();
  e.fromStation.fire('focus');
  assert.equal(e.fromSuggestions.children.length, 250);
  assert.equal(new Set(e.fromSuggestions.children.map(option => option.textContent)).size, 250);
  assert.equal(e.runTravel.disabled, true);
  assert.equal(e.fromStation.disabled, false);
  assert.equal(map.layers['transit-label'].layout.visibility, 'none');
  choose('toStation', 'ST037');
  e.fromStation.value = 'Kengeri';
  e.fromStation.fire('input');
  assert.equal(e.runTravel.disabled, true);
  assert.match(e.travelStatus.textContent, /share that name/);
  choose('fromStation', 'ST037');
  assert.equal(e.runTravel.disabled, true);
  choose('fromStation', 'ST001');
  assert.equal(e.runTravel.disabled, false);
  e.fromStation.value = 'not a station';
  e.fromStation.fire('input');
  assert.equal(e.runTravel.disabled, true);
});

test('station dropdown stays open while editing and closes on selection', async () => {
  const { elements: e, documentEvents } = await setup();
  e.fromStation.fire('focus');
  for (const text of ['K', 'Ke', 'Keng', 'Kengeri', 'unknown station', 'Ke', '']) {
    e.fromStation.value = text;
    e.fromStation.fire('input');
    assert.equal(e.fromSuggestions.hidden, false);
    assert.equal(e.fromStation.attributes['aria-expanded'], 'true');
    assert.ok(e.fromSuggestions.children.length);
    if (text === 'unknown station') {
      assert.equal(e.fromSuggestions.children[0].textContent, 'No matching stations');
    } else {
      assert.ok(e.fromSuggestions.children.every(option =>
        option.textContent.toLowerCase().includes(text.toLowerCase())));
    }
  }
  const option = e.fromSuggestions.children[0];
  documentEvents.pointerdown({ target: option });
  assert.equal(e.fromSuggestions.hidden, false);
  option.fire('click');
  assert.equal(e.fromSuggestions.hidden, true);
  assert.equal(e.fromStation.attributes['aria-expanded'], 'false');
  assert.equal(e.fromStation.value, option.textContent);
  e.fromStation.value = 'Ke';
  e.fromStation.fire('input');
  assert.equal(e.fromSuggestions.hidden, false);
  documentEvents.pointerdown({ target: e.runTravel });
  assert.equal(e.fromSuggestions.hidden, true);
  e.fromStation.fire('focus');
  documentEvents.focusin({ target: e.toStation });
  e.toStation.fire('focus');
  assert.equal(e.fromSuggestions.hidden, true);
  assert.equal(e.toSuggestions.hidden, false);
});

test('station dropdown supports keyboard selection and explicit dismissal', async () => {
  const { elements: e } = await setup();
  e.fromStation.value = 'Kengeri';
  e.fromStation.fire('input');
  e.fromStation.fire('keydown', { key: 'ArrowDown' });
  assert.equal(e.fromSuggestions.children[0].attributes['aria-selected'], 'true');
  assert.equal(e.fromStation.attributes['aria-activedescendant'], e.fromSuggestions.children[0].id);
  const choice = e.fromSuggestions.children[0].textContent;
  e.fromStation.fire('keydown', { key: 'Enter' });
  assert.equal(e.fromStation.value, choice);
  assert.equal(e.fromSuggestions.hidden, true);
  assert.equal(e.fromStation.attributes['aria-expanded'], 'false');
  e.fromStation.fire('click');
  e.fromStation.fire('keydown', { key: 'Escape' });
  assert.equal(e.fromSuggestions.hidden, true);
  assert.equal(e.fromStation.attributes['aria-activedescendant'], undefined);
  e.fromStation.fire('click');
  assert.equal(e.fromSuggestions.hidden, false);
  e.fromStation.fire('keydown', { key: 'Tab' });
  assert.equal(e.fromSuggestions.hidden, true);
});

test('map picking fills the selected field, misses stay active, and Escape cancels', async () => {
  const { elements: e, map, documentEvents } = await setup();
  e.pickFrom.fire('click');
  assert.equal(e.pickFrom.attributes['aria-pressed'], 'true');
  map.events.click({ point: { x: 0, y: 0 } });
  assert.match(e.travelStatus.textContent, /No station/);
  const station = stations[0];
  map.rendered = [station];
  map.events.click({ point: map.project(station.geometry.coordinates) });
  assert.equal(e.fromStation.value, 'Challaghatta');
  assert.equal(e.toStation.value, '');
  assert.equal(e.pickFrom.attributes['aria-pressed'], 'false');
  e.pickTo.fire('click');
  documentEvents.keydown({ key: 'Escape' });
  assert.equal(map.canvas.style.cursor, '');
  assert.equal(e.pickTo.attributes['aria-pressed'], 'false');
});

test('station clicks show the requested table and close on replacement, outside click, or hiding', async () => {
  const { elements: e, map, popups } = await setup();
  function click(station) {
    map.rendered = [station];
    map.events.click({ point: map.project(station.geometry.coordinates) });
  }
  click(stations[0]);
  assert.equal(popups.length, 1);
  const popup = popups[0];
  assert.equal(popup.options.className, 'station-popup');
  assert.deepEqual(popup.coordinates, stations[0].geometry.coordinates);
  const table = popup.content.children[0];
  assert.equal(table.tagName, 'table');
  const rows = Object.fromEntries(table.children.slice(1).map(row =>
    row.children.map(cell => cell.textContent)));
  assert.deepEqual(rows, {
    Name: 'Challaghatta',
    'Coordinates (lat, lon)': '12.897354, 77.461288',
    'Opening date': '2023-10-09',
    'Opening year': '2023'
  });
  assert.match(popup.content.children[1].textContent, /not construction completion/);
  assert.equal(e.fromStation.value, '');
  assert.equal(e.toStation.value, '');
  click(stations[1]);
  assert.equal(popup.removed, true);
  assert.equal(popups.length, 2);
  e.showMetro.checked = false;
  e.showMetro.fire('change');
  assert.equal(popups[1].removed, true);
  e.showMetro.checked = true;
  e.showMetro.fire('change');
  click(stations[0]);
  const status = e.travelStatus.textContent;
  map.rendered = [];
  map.events.click({ point: { x: 0, y: 0 } });
  assert.equal(popups[2].removed, true);
  assert.equal(e.travelStatus.textContent, status);
});

test('station popup reports missing dates and source date conflicts without inventing completion dates', async () => {
  const { map, popups } = await setup();
  const missing = stations.find(station =>
    station.properties.station_opening_date === null && station.properties.station_opening_year === null);
  map.rendered = [missing];
  map.events.click({ point: map.project(missing.geometry.coordinates) });
  const rows = popups[0].content.children[0].children;
  assert.equal(rows[3].children[1].textContent, '-');
  assert.equal(rows[4].children[1].textContent, '-');
  const conflict = stations.find(station => station.properties.opening_date_conflict);
  map.rendered = [conflict];
  map.events.click({ point: map.project(conflict.geometry.coordinates) });
  assert.match(popups[1].content.children[1].textContent, /conflicting opening dates/);
});

test('station info does not clear a route and map picking takes precedence over popups', async () => {
  const { elements: e, map, popups, choose } = await setup();
  choose('fromStation', 'ST001');
  choose('toStation', 'ST250');
  e.travelForm.fire('submit');
  const route = map.sources['travel-path'].data;
  map.rendered = [stations[1]];
  const event = { point: map.project(stations[1].geometry.coordinates) };
  map.events.click(event);
  assert.equal(map.sources['travel-path'].data, route);
  assert.equal(popups.length, 1);
  e.pickFrom.fire('click');
  assert.equal(popups[0].removed, true);
  map.events.click(event);
  assert.equal(popups.length, 1);
  assert.equal(e.fromStation.value, 'Kengeri [ST002]');
  assert.equal(e.pickFrom.attributes['aria-pressed'], 'false');
});

test('Travel displays the line-change priority and count alongside route distance', async () => {
  const { elements: e, map, choose } = await setup();
  choose('fromStation', 'ST001');
  choose('toStation', 'ST037');
  e.travelForm.fire('submit');
  assert.equal(e.travelStatus.textContent, '');
  assert.equal(e.travelResult.children[0].children.find(row =>
    row.children[0].textContent === 'Line changes').children[1].textContent, '0');
  assert.ok(map.sources['travel-path'].data.features.every(feature =>
    feature.properties.route_id === 'purple'));
  choose('toStation', 'ST068');
  e.travelForm.fire('submit');
  assert.equal(e.travelStatus.textContent, '');
  assert.equal(e.travelResult.children[0].children.find(row =>
    row.children[0].textContent === 'Line changes').children[1].textContent, '1');
  const lines = new Set(map.sources['travel-path'].data.features
    .filter(feature => feature.properties.feature_type === 'route').map(feature => feature.properties.route_id));
  assert.deepEqual([...lines].sort(), ['green', 'purple']);
});

test('Travel details and formulas live on the right and update without deleting saved construction phases', async () => {
  const { elements: e, choose } = await setup();
  const text = element => [element.textContent || '', ...element.children.map(text)].join(' ');
  const rows = () => Object.fromEntries(e.travelResult.children[0].children.map(row =>
    row.children.map(cell => cell.textContent)));
  const rightMarkup = html.slice(html.indexOf('<aside id="rightSidebar"'));
  assert.match(rightMarkup, /id="travelStatus"/);
  assert.match(rightMarkup, /id="travelResult"/);
  assert.match(rightMarkup, /id="travelFormulas"/);
  assert.doesNotMatch(html.match(/<form id="travelForm">[\s\S]*?<\/form>/)[0], /travelStatus|travelResult/);
  assert.equal(e.travelPanel.hidden, false);
  assert.equal(e.builtPlan.hidden, true);
  assert.match(text(e.travelFormulas), /40 km\/h/);
  assert.match(text(e.travelFormulas), /50 km\/h/);
  assert.match(text(e.travelFormulas), /12 min/);
  assert.match(text(e.travelFormulas), /9 February 2025/);
  assert.match(text(e.travelFormulas), /Not confirmed current in October 2026/);
  assert.match(text(e.travelFormulas), /Suburban fare assumption \(not official\)/);
  choose('fromStation', 'ST001');
  choose('toStation', 'ST037');
  e.travelForm.fire('submit');
  assert.equal(rows()['Stations (incl. endpoints)'], '37');
  assert.equal(rows()['Line changes'], '0');
  assert.match(rows()['Distance'], /^\d+\.\d{2} km$/);
  assert.match(rows()['Estimated time'], /^\d+\.\d min$/);
  assert.equal(rows()['Total cost (estimate)'], 'INR 90');
  assert.match(text(e.travelResult), /Metro - Purple/);
  assert.match(text(e.travelResult), /Planning estimate, not a ticket quote/);
  const displayed = e.travelResult.children[0];
  e.showMetro.checked = false;
  e.showMetro.fire('change');
  assert.equal(e.travelResult.children[0], displayed, 'visibility toggles do not invalidate the trip');
  e.clearTravel.fire('click');
  assert.equal(e.travelResult.children.length, 0);
  e.addPhase.fire('click');
  const phase = phaseControls(e, 1);
  phase.choose('from', 'ST100');
  phase.choose('to', 'ST106');
  e.buildPlan.fire('click');
  const saved = e.builtPlan.children[1];
  assert.equal(e.travelPanel.hidden, true);
  assert.equal(e.builtPlan.hidden, false);
  e.travelMode.fire('click');
  assert.equal(e.travelPanel.hidden, false);
  assert.equal(e.builtPlan.hidden, true);
  assert.equal(e.builtPlan.children[1], saved);
  choose('fromStation', 'ST001');
  choose('toStation', 'ST250');
  e.travelForm.fire('submit');
  assert.ok(Number(rows()['Suburban fare estimate'].slice(4)) > 0);
  e.previousYear.fire('click');
  assert.equal(e.travelResult.children.length, 0);
  choose('fromStation', 'ST001');
  choose('toStation', 'ST037');
  e.travelForm.fire('submit');
  choose('toStation', 'ST002');
  assert.equal(e.travelResult.children.length, 0);
  e.travelForm.fire('submit');
  e.constructionMode.fire('click');
  assert.equal(e.travelResult.children.length, 0);
  assert.equal(e.builtPlan.children[1], saved);
});

test('formulas show only totals, full-word subscripts, and numeric constant tables', async () => {
  const { elements: e } = await setup();
  const equations = e.travelFormulas.children.filter(child => child.className === 'travel-equation');
  const expression = element => element.children.map(child =>
    child.tagName === 'sub' ? '_' + child.textContent : child.textContent).join('');
  assert.deepEqual(equations.map(expression), [
    'D = D_metro + D_suburban + D_walking',
    'T = T_move + T_stop + T_change',
    'C = C_metro + C_suburban'
  ]);
  const tables = e.travelFormulas.children.filter(child => child.tagName === 'table')
    .map(table => table.children.map(row => row.children.map(cell => cell.textContent)));
  assert.deepEqual(tables.slice(0, 2), [
    [
      ['Earth radius', '6,371 km'],
      ['Metro speed', '40 km/h'],
      ['Suburban speed', '50 km/h'],
      ['Walking speed', '4.5 km/h'],
      ['Metro stop', '0.5 min'],
      ['Suburban stop', '1 min'],
      ['Same-system transfer', '5 min'],
      ['Metro / suburban transfer', '12 min']
    ],
    [
      ['Suburban minimum', 'INR 10'],
      ['Suburban rate', 'INR 2/km']
    ]
  ]);
  assert.equal(tables.length, 3);
  assert.equal(tables[2].length, 10, 'all dated Metro fare slabs remain visible');
  assert.ok(tables.flat().every(([, value]) => /\d/.test(value)), 'every table row has a numeric value');
  const notes = e.travelFormulas.children.filter(child =>
    child.tagName === 'p' && child.className !== 'travel-equation');
  assert.ok(notes.some(note =>
    note.textContent === 'First minimize the number of line changes, then minimize the distance travelled.'));
  assert.ok(notes.every(note => note.textContent.split(/\s+/).length <= 25));
  assert.ok(e.travelFormulas.children.some(child => child.tagName === 'a' && child.href.includes('bmrc.co.in')));
});

test('Travel renders ordered solid and dashed line graphics with only each leg endpoint labelled', async () => {
  const { elements: e, choose } = await setup();
  const TravelInfo = require('../travel-info.js');
  for (const [from, to] of [['ST001', 'ST250'], ['ST250', 'ST001'], ['ST001', 'ST037']]) {
    choose('fromStation', from);
    choose('toStation', to);
    e.travelForm.fire('submit');
    const trip = RailRouting.findRoute(RailRouting.buildNetwork(data), from, to);
    const info = TravelInfo.calculate(trip);
    const list = e.travelResult.children.find(child => child.className === 'travel-journey');
    assert.equal(list.children.length, info.lines.length);
    for (const [i, item] of list.children.entries()) {
      const line = info.lines[i];
      const [track, start, label, end] = item.children;
      assert.equal(track.className, 'journey-track');
      assert.equal(track.style.color, line.color);
      assert.equal(track.attributes['data-system'], line.system);
      assert.equal(track.attributes['aria-hidden'], 'true');
      assert.equal(start.className, 'journey-start');
      assert.equal(end.className, 'journey-end');
      for (const [element, id] of [[start, line.from], [end, line.to]]) {
        const station = stations.find(station => station.properties.id === id);
        const duplicates = stations.filter(other =>
          other.properties.name.toLowerCase() === station.properties.name.toLowerCase()).length;
        assert.equal(element.textContent, duplicates > 1 ?
          `${station.properties.name} [${id}]` : station.properties.name);
      }
      assert.equal(label.textContent, `${line.name} (${line.km.toFixed(2)} km)`);
      assert.equal(item.children.length, 4, 'no intermediate station labels');
    }
    assert.equal(e.travelStatus.textContent, '');
  }
});

test('Run highlights only real route segments, filters labels, marks endpoints, and resets on edits', async () => {
  const { elements: e, map, markers, choose, errors } = await setup();
  choose('fromStation', 'ST001');
  choose('toStation', 'ST250');
  e.showMetro.checked = false;
  e.showSuburban.checked = false;
  e.showStationNames.checked = false;
  e.travelForm.fire('submit');
  const expected = RailRouting.findRoute(RailRouting.buildNetwork(data), 'ST001', 'ST250');
  assert.deepEqual(map.sources['travel-path'].data, expected.geojson);
  assert.equal(e.showMetro.checked, true);
  assert.equal(e.showSuburban.checked, true);
  assert.equal(e.showStationNames.checked, true);
  for (const id of ['rail-routes', 'suburban-routes', 'rail-transfers']) {
    assert.equal(map.layers[id].paint['line-color'], '#000000');
    assert.equal(map.layers[id].paint['line-width'], 0.75);
    assert.deepEqual(map.layers[`travel-${id}`].paint['line-color'], ['get', 'stroke']);
  }
  assert.equal(map.layers['travel-suburban-routes'].paint['line-width'], 1);
  assert.deepEqual(map.layers['travel-suburban-routes'].paint['line-dasharray'], [9, 6]);
  assert.equal(map.layers['station-names'].paint['text-color'], '#000000');
  for (const station of stations) {
    assert.equal(evaluate(map.layers['station-names'].filter, station),
      expected.stationIds.includes(station.properties.id));
  }
  assert.equal(markers.length, 2);
  assert.equal(markers[0].element.className, 'endpoint-marker');
  assert.deepEqual(markers[0].coordinates, stations[0].geometry.coordinates);
  assert.deepEqual(markers[1].coordinates, stations[249].geometry.coordinates);
  assert.ok(map.bounds.points.length > expected.stationIds.length);
  assert.equal(errors.length, 0);

  // A second run replaces markers instead of accumulating visible rectangles.
  e.travelForm.fire('submit');
  assert.ok(markers.slice(0, 2).every(marker => marker.removed));
  assert.equal(markers.filter(marker => !marker.removed).length, 2);
  choose('fromStation', 'ST002');
  assert.equal(map.sources['travel-path'].data.features.length, 0);
  assert.ok(markers.every(marker => marker.removed));
  assert.equal(map.layers['rail-routes'].paint['line-width'], 3);
  assert.equal(map.layers['suburban-routes'].paint['line-width'], 1);
  assert.deepEqual(Array.from(map.layers['rail-routes'].paint['line-color']), ['get', 'stroke']);
  assert.ok(stations.every(station => evaluate(map.layers['station-names'].filter, station)));
});

test('all footer combinations still control highlighted networks, labels, and endpoints', async () => {
  const { elements: e, map, markers, choose } = await setup({
    beforeLoad(elements) { elements.showMetro.checked = false; }
  });
  assert.equal(map.layers['rail-routes'].layout.visibility, 'none');
  choose('fromStation', 'ST001');
  choose('toStation', 'ST250');
  e.travelForm.fire('submit');
  for (let mask = 0; mask < 8; mask++) {
    e.showMetro.checked = !!(mask & 1);
    e.showSuburban.checked = !!(mask & 2);
    e.showStationNames.checked = !!(mask & 4);
    e.showMetro.fire('change');
    e.showSuburban.fire('change');
    e.showStationNames.fire('change');
    assert.equal(map.layers['travel-rail-routes'].layout.visibility, mask & 1 ? 'visible' : 'none');
    assert.equal(map.layers['travel-suburban-routes'].layout.visibility, mask & 2 ? 'visible' : 'none');
    assert.equal(map.layers['travel-rail-transfers'].layout.visibility, (mask & 3) === 3 ? 'visible' : 'none');
    assert.equal(map.layers['station-names'].layout.visibility, mask & 4 ? 'visible' : 'none');
    assert.equal(markers[0].element.hidden, !(mask & 1));
    assert.equal(markers[1].element.hidden, !(mask & 2));
  }
});

test('Clear resets fields, picking, and the route while preserving footer settings', async () => {
  const { elements: e, map, markers, choose } = await setup();
  assert.equal(e.clearTravel.disabled, false);
  e.clearTravel.fire('click');
  assert.equal(e.runTravel.disabled, true);
  choose('fromStation', 'ST001');
  choose('toStation', 'ST250');
  e.travelForm.fire('submit');
  e.showSuburban.checked = false;
  e.showSuburban.fire('change');
  e.pickFrom.fire('click');
  e.clearTravel.fire('click');
  assert.equal(e.fromStation.value, '');
  assert.equal(e.toStation.value, '');
  assert.equal(e.runTravel.disabled, true);
  assert.equal(e.pickFrom.attributes['aria-pressed'], 'false');
  assert.equal(e.pickTo.attributes['aria-pressed'], 'false');
  assert.equal(map.canvas.style.cursor, '');
  assert.equal(map.sources['travel-path'].data.features.length, 0);
  assert.ok(markers.every(marker => marker.removed));
  assert.equal(map.layers['rail-routes'].paint['line-width'], 3);
  assert.equal(map.layers['suburban-routes'].paint['line-width'], 1);
  assert.deepEqual(Array.from(map.layers['rail-routes'].paint['line-color']), ['get', 'stroke']);
  assert.equal(e.showSuburban.checked, false);
  assert.equal(map.layers['suburban-routes'].layout.visibility, 'none');
  for (const station of stations) {
    assert.equal(evaluate(map.layers['station-names'].filter, station),
      station.properties.system === 'metro');
  }
  e.clearTravel.fire('click');
  assert.match(e.travelStatus.textContent, /Travel cleared/);
  choose('fromStation', 'ST001');
  choose('toStation', 'ST002');
  assert.equal(e.runTravel.disabled, false);
  e.travelForm.fire('submit');
  assert.ok(map.sources['travel-path'].data.features.length > 0);
});

test('construction Clear resets only current selections while preserving its number and all saved work', async () => {
  const { elements: e, map, documentEvents } = await setup();
  const initialListeners = documentEvents.pointerdown.listeners.size;
  assert.equal(e.clearPlan.disabled, true);
  e.addPhase.fire('click');
  const first = phaseControls(e, 1);
  first.choose('from', 'ST100');
  first.choose('to', 'ST106');
  e.buildPlan.fire('click');
  const savedSection = e.builtPlan.children[1];
  const savedFeatures = structuredClone(map.sources['construction-path'].data.features);
  assert.equal(e.clearPlan.disabled, true);
  e.addPhase.fire('click');
  const second = phaseControls(e, 2);
  second.number.value = '9';
  second.number.fire('input');
  second.choose('from', 'ST084');
  second.choose('to', 'ST088');
  assert.ok(map.sources['construction-path'].data.features.length > savedFeatures.length);
  second.to.fire('focus');
  assert.equal(e.clearPlan.disabled, false);
  const draftListeners = documentEvents.pointerdown.listeners.size;
  assert.ok(draftListeners > initialListeners);
  e.clearPlan.fire('click');
  assert.equal(e.phaseList.children.length, 1);
  assert.equal(second.number.value, '9');
  assert.equal(second.from.value, '');
  assert.equal(second.to.value, '');
  assert.equal(second.line.value, '');
  assert.equal(second.line.hidden, true);
  assert.equal(second.to.disabled, true);
  assert.equal(second.pickTo.disabled, true);
  assert.equal(descendant(e.phaseList, 'phase-2-to-suggestions').hidden, true);
  assert.equal(e.builtPlan.children.length, 2);
  assert.equal(e.builtPlan.children[0].textContent, '1 phase built.');
  assert.equal(e.builtPlan.children[1], savedSection);
  assert.equal(e.addPhase.hidden, true);
  assert.equal(e.buildPlan.disabled, true);
  assert.equal(e.clearPlan.disabled, false);
  assert.equal(e.constructionMode.attributes['aria-pressed'], 'true');
  assert.deepEqual(structuredClone(map.sources['construction-path'].data.features), savedFeatures);
  assert.equal(map.layers['rail-routes'].paint['line-width'][3][1], true);
  assert.equal(map.layers['rail-stations'].paint['circle-radius'][1][2][1].length, 7);
  assert.equal(documentEvents.pointerdown.listeners.size, draftListeners);
  assert.match(e.constructionStatus.textContent, /selections cleared/);
  e.clearPlan.fire('click');
  second.from.fire('focus');
  assert.ok(!second.suggestions('from').includes('ST103'));
  assert.ok(second.suggestions('from').includes('ST084'));
  second.choose('from', 'ST084');
  second.choose('to', 'ST088');
  const draftValues = [second.number.value, second.from.value, second.to.value];
  e.travelMode.fire('click');
  assert.equal(e.clearPlan.disabled, true);
  e.clearPlan.fire('click');
  assert.deepEqual([second.number.value, second.from.value, second.to.value], draftValues);
  e.constructionMode.fire('click');
  e.buildPlan.fire('click');
  assert.equal(e.phaseList.children.length, 0);
  assert.equal(e.builtPlan.children[1], savedSection);
  assert.equal(e.builtPlan.children[2].children[0].textContent, 'Phase 9');
  assert.equal(documentEvents.pointerdown.listeners.size, initialListeners);
  assert.equal(e.clearPlan.disabled, true);
});

test('loading failures are visible and do not enable routing', async () => {
  const { elements, errors } = await setup({ failFetch: true });
  assert.match(elements.travelStatus.textContent, /HTTP 404/);
  assert.equal(elements.runTravel.disabled, true);
  assert.equal(elements.pickFrom.disabled, true);
  assert.equal(elements.clearTravel.disabled, true);
  assert.equal(elements.previousYear.disabled, true);
  assert.equal(elements.nextYear.disabled, true);
  assert.equal(elements.autoplayYears.disabled, true);
  assert.equal(elements.addPhase.disabled, true);
  assert.equal(elements.clearPlan.disabled, true);
  assert.equal(elements.constructionMode.disabled, true);
  assert.equal(errors.length, 1);
});

test('autoplay holds each year for one second, loops, pauses, and cleans up its timer', async () => {
  const { elements: e, map, timers, advanceTime } = await setup();
  assert.equal(e.autoplayYears.disabled, false);
  assert.equal(timers.size, 0);
  e.autoplayYears.fire('click');
  assert.equal(e.mapYear.textContent, '2010');
  assert.equal(e.autoplayYears.attributes['aria-pressed'], 'true');
  assert.equal(e.autoplayYears.attributes['aria-label'], 'Pause years');
  assert.equal(timers.size, 1);
  for (const expected of [...Array.from({ length: 16 }, (_, i) => String(2011 + i)), 'final plan', '2010']) {
    const previous = e.mapYear.textContent;
    advanceTime(999);
    assert.equal(e.mapYear.textContent, previous);
    advanceTime(1);
    assert.equal(e.mapYear.textContent, expected);
  }
  e.autoplayYears.fire('click');
  assert.equal(timers.size, 0);
  assert.equal(e.autoplayYears.attributes['aria-label'], 'Play years');
  advanceTime(3000);
  assert.equal(e.mapYear.textContent, '2010');
  e.autoplayYears.fire('click');
  advanceTime(2000);
  assert.equal(e.mapYear.textContent, '2012');
  e.previousYear.fire('click');
  assert.equal(e.mapYear.textContent, '2011');
  assert.equal(timers.size, 0);
  e.autoplayYears.fire('click');
  assert.equal(e.mapYear.textContent, '2010');
  e.nextYear.fire('click');
  assert.equal(e.mapYear.textContent, '2011');
  assert.equal(timers.size, 0);
  e.autoplayYears.fire('click');
  map.events.remove();
  assert.equal(timers.size, 0);
  assert.equal(e.autoplayYears.attributes['aria-pressed'], 'false');
});

test('year arrows cover 2010-2026 and final plan without wrapping, updating search and geometry', async () => {
  const { elements: e, map } = await setup();
  assert.equal(e.mapYear.textContent, 'final plan');
  assert.equal(e.mapYear.attributes['data-final-plan'], 'true');
  assert.equal(e.previousYear.disabled, false);
  assert.equal(e.nextYear.disabled, true);
  assert.equal(map.sources['rail-network'].data.features.length, 282);
  for (let year = 2026; year >= 2010; year--) {
    e.previousYear.fire('click');
    assert.equal(e.mapYear.textContent, String(year));
    assert.equal(e.mapYear.attributes['data-final-plan'], 'false');
    e.fromStation.value = '';
    e.fromStation.fire('focus');
    const expected = RailRouting.forYear(RailRouting.buildNetwork(data), year);
    assert.deepEqual(map.sources['rail-network'].data, RailRouting.toGeoJSON(expected));
    if (expected.stations.size) {
      assert.equal(e.fromSuggestions.children.length, expected.stations.size);
    } else {
      assert.equal(e.fromSuggestions.children[0].textContent, 'No matching stations');
      assert.match(e.travelStatus.textContent, /No stations/);
    }
    assert.equal(e.previousYear.disabled, year === 2010);
    assert.equal(e.nextYear.disabled, false);
  }
  e.previousYear.fire('click');
  assert.equal(e.mapYear.textContent, '2010');
  for (let year = 2011; year <= 2026; year++) {
    e.nextYear.fire('click');
    assert.equal(e.mapYear.textContent, String(year));
  }
  e.nextYear.fire('click');
  assert.equal(e.mapYear.textContent, 'final plan');
  assert.equal(e.mapYear.attributes['data-final-plan'], 'true');
  assert.equal(e.nextYear.disabled, true);
  assert.equal(map.sources['rail-network'].data, data);
  e.fromStation.fire('focus');
  assert.equal(e.fromSuggestions.children.length, 250);
});

test('changing year clears stale routes, popup and picking, and routing cannot use future lines', async () => {
  const { elements: e, map, markers, popups, choose } = await setup();
  choose('fromStation', 'ST001');
  choose('toStation', 'ST250');
  e.travelForm.fire('submit');
  map.rendered = [stations[0]];
  map.events.click({ point: map.project(stations[0].geometry.coordinates) });
  assert.equal(popups.length, 1);
  e.showSuburban.checked = false;
  e.showSuburban.fire('change');
  e.previousYear.fire('click');
  assert.equal(e.mapYear.textContent, '2026');
  assert.equal(e.fromStation.value, 'Challaghatta');
  assert.equal(e.toStation.value, '');
  assert.equal(e.runTravel.disabled, true);
  assert.ok(markers.every(marker => marker.removed));
  assert.equal(popups[0].removed, true);
  assert.equal(map.sources['travel-path'].data.features.length, 0);
  assert.equal(e.showSuburban.checked, false);
  e.pickFrom.fire('click');
  e.previousYear.fire('click');
  assert.equal(e.pickFrom.attributes['aria-pressed'], 'false');
  assert.equal(map.canvas.style.cursor, '');
  while (e.mapYear.textContent !== '2015') e.previousYear.fire('click');
  choose('fromStation', 'ST008');
  choose('toStation', 'ST019');
  e.travelForm.fire('submit');
  assert.match(e.travelStatus.textContent, /No connected path/);
  e.nextYear.fire('click');
  assert.equal(e.mapYear.textContent, '2016');
  assert.equal(e.runTravel.disabled, false);
  e.travelForm.fire('submit');
  assert.ok(map.sources['travel-path'].data.features.length > 0);
  assert.ok(map.sources['travel-path'].data.features.every(f => f.properties.route_id === 'purple'));
});
