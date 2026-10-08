const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildNetwork, forYear, toGeoJSON, findRoute } = require('../routing.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'datasets',
  'Bengaluru_metro_suburban_rail_upgraded.geojson'), 'utf8'));
const network = buildNetwork(data);

test('every graph edge follows an original line slice and exact station endpoints', () => {
  assert.equal(network.stations.size, 250);
  const originals = new Map(data.features.map(feature => [feature.properties.id, feature]));
  for (const [id, edges] of network.graph) {
    assert.ok(edges.length, `Unconnected station ${id}`);
    for (const edge of edges) {
      const line = edge.feature.geometry.coordinates;
      const original = originals.get(edge.feature.properties.id).geometry.coordinates;
      assert.ok(original.some((point, start) =>
        JSON.stringify(original.slice(start, start + line.length)) === JSON.stringify(line)));
      assert.deepEqual(line[edge.reverse ? line.length - 1 : 0],
        network.stations.get(id).geometry.coordinates);
      assert.deepEqual(line[edge.reverse ? 0 : line.length - 1],
        network.stations.get(edge.to).geometry.coordinates);
      assert.ok(edge.meters >= 0);
      assert.equal(edge.feature.properties.stroke, originals.get(edge.feature.properties.id).properties.stroke);
    }
  }
});

test('routes agree with independent line-aware Bellman-Ford costs and preserve exact geometry', () => {
  const ids = [...network.stations.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const lines = [null, ...data.features.filter(feature => feature.properties.feature_type === 'route')
    .map(feature => feature.properties.route_id)];
  const transitions = [];
  for (const [id, edges] of network.graph) {
    for (const edge of edges) {
      for (let previous = 0; previous < lines.length; previous++) {
        const next = edge.feature.properties.feature_type === 'route' ?
          lines.indexOf(edge.feature.properties.route_id) : previous;
        transitions.push([
          index.get(id) * lines.length + previous,
          index.get(edge.to) * lines.length + next,
          previous !== 0 && previous !== next ? 1 : 0,
          edge.meters
        ]);
      }
    }
  }
  const changes = Array(ids.length * lines.length).fill(Infinity);
  const distances = Array(changes.length).fill(Infinity);
  const source = index.get('ST001') * lines.length;
  changes[source] = distances[source] = 0;
  for (let pass = 0; pass < changes.length - 1; pass++) {
    let updated = false;
    for (const [from, to, change, meters] of transitions) {
      const candidateChanges = changes[from] + change;
      const candidateDistance = distances[from] + meters;
      if (candidateChanges < changes[to] ||
          (candidateChanges === changes[to] && candidateDistance < distances[to])) {
        changes[to] = candidateChanges;
        distances[to] = candidateDistance;
        updated = true;
      }
    }
    if (!updated) break;
  }
  for (const from of ids) {
    const to = from === 'ST001' ? 'ST250' : 'ST001';
    const target = index.get(from === 'ST001' ? to : from) * lines.length;
    const expected = lines.map((_, i) => ({ changes: changes[target + i], meters: distances[target + i] }))
      .sort((a, b) => a.changes - b.changes || a.meters - b.meters)[0];
    const result = findRoute(network, from, to);
    assert.equal(result.lineChanges, expected.changes);
    assert.ok(Math.abs(result.meters - expected.meters) < 0.0001);
    assert.equal(result.stationIds[0], from);
    assert.equal(result.stationIds.at(-1), to);
    assert.equal(result.geojson.features.length, result.stationIds.length - 1);
    assert.equal(result.segmentMeters.length, result.geojson.features.length);
    assert.ok(Math.abs(result.segmentMeters.reduce((sum, meters) => sum + meters, 0) - result.meters) < 0.0001);
    result.geojson.features.forEach((feature, i) => {
      assert.deepEqual(feature.geometry.coordinates[0],
        network.stations.get(result.stationIds[i]).geometry.coordinates);
      assert.deepEqual(feature.geometry.coordinates.at(-1),
        network.stations.get(result.stationIds[i + 1]).geometry.coordinates);
    });
  }
});

function fixture(edges) {
  const ids = [...new Set(edges.flatMap(([from, to]) => [from, to]))];
  const stations = new Map(ids.map((id, i) => [id, {
    type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: [i, 0] }
  }]));
  const graph = new Map(ids.map(id => [id, []]));
  for (const [from, to, line, meters] of edges) {
    const feature = {
      type: 'Feature',
      properties: line === null ? { feature_type: 'walking_transfer' } :
        { feature_type: 'route', route_id: line },
      geometry: { type: 'LineString', coordinates: [
        stations.get(from).geometry.coordinates, stations.get(to).geometry.coordinates
      ] }
    };
    graph.get(from).push({ to, meters, feature, reverse: false });
    graph.get(to).push({ to: from, meters, feature, reverse: true });
  }
  return { stations, graph };
}

test('fewer line changes outrank any distance saving, and equal changes use shortest distance', () => {
  const fewerChanges = fixture([
    ['S', 'A', 'red', 500000], ['A', 'T', 'red', 500000],
    ['S', 'B', 'blue', 1], ['B', 'T', 'green', 1]
  ]);
  const first = findRoute(fewerChanges, 'S', 'T');
  assert.deepEqual(first.stationIds, ['S', 'A', 'T']);
  assert.equal(first.lineChanges, 0);
  assert.equal(first.meters, 1000000);
  const tie = fixture([
    ['S', 'A', 'red', 10], ['A', 'T', 'blue', 10],
    ['S', 'B', 'green', 2], ['B', 'T', 'yellow', 3]
  ]);
  const second = findRoute(tie, 'S', 'T');
  assert.deepEqual(second.stationIds, ['S', 'B', 'T']);
  assert.equal(second.lineChanges, 1);
  assert.equal(second.meters, 5);
});

test('arrivals at the same station retain separate line states', () => {
  const net = fixture([
    ['S', 'I', 'red', 1], ['S', 'A', 'blue', 5],
    ['A', 'I', 'blue', 5], ['I', 'T', 'blue', 1]
  ]);
  const result = findRoute(net, 'S', 'T');
  assert.deepEqual(result.stationIds, ['S', 'A', 'I', 'T']);
  assert.equal(result.lineChanges, 0);
  assert.equal(result.meters, 11);
});

test('walking does not reset the previous line or count as boarding, and return-to-line changes count again', () => {
  for (const [lastLine, changes] of [['blue', 1], ['red', 0]]) {
    const net = fixture([
      ['S', 'A', null, 1], ['A', 'B', 'red', 2],
      ['B', 'C', null, 0], ['C', 'D', null, 3],
      ['D', 'E', lastLine, 4], ['E', 'T', null, 5]
    ]);
    for (const [from, to] of [['S', 'T'], ['T', 'S']]) {
      const result = findRoute(net, from, to);
      assert.equal(result.lineChanges, changes);
      assert.equal(result.meters, 15);
    }
  }
  const changingBack = findRoute(fixture([
    ['S', 'A', 'red', 1], ['A', 'B', 'blue', 1], ['B', 'T', 'red', 1]
  ]), 'S', 'T');
  assert.equal(changingBack.lineChanges, 2);
  const walkingOnly = findRoute(fixture([['S', 'T', null, 2]]), 'S', 'T');
  assert.equal(walkingOnly.lineChanges, 0);
  assert.equal(walkingOnly.meters, 2);
});

test('reverse routing and explicit transfers preserve supplied geometry', () => {
  const forward = findRoute(network, 'ST001', 'ST002');
  const reverse = findRoute(network, 'ST002', 'ST001');
  assert.deepEqual(reverse.stationIds, [...forward.stationIds].reverse());
  assert.deepEqual(reverse.geojson.features[0].geometry.coordinates,
    [...forward.geojson.features[0].geometry.coordinates].reverse());
  const transfer = findRoute(network, 'ST214', 'ST238');
  assert.equal(transfer.geojson.features[0].properties.id, 'I11');
});

test('invalid, identical, disconnected, and malformed station connections report errors', () => {
  assert.throws(() => findRoute(network, 'invalid', 'ST001'), /Choose both stations/);
  assert.throws(() => findRoute(network, 'ST001', 'ST001'), /different stations/);
  const disconnected = buildNetwork({
    type: 'FeatureCollection',
    features: data.features.filter(feature => feature.geometry.type === 'Point')
  });

  assert.throws(() => findRoute(disconnected, 'ST001', 'ST002'), /No connected path/);
  const broken = structuredClone(data);
  broken.features.find(feature => feature.properties.id === 'ST001').geometry.coordinates = [0, 0];
  assert.throws(() => buildNetwork(broken), /missing from route/);
});

test('every selectable year includes only recorded openings and final plan restores everything', () => {
  const counts = [0, 6, 6, 6, 16, 25, 30, 40, 40, 40, 40, 51, 51, 65, 68, 83, 83];
  for (let year = 2010; year <= 2026; year++) {
    const visible = forYear(network, year);
    assert.equal(visible.stations.size, counts[year - 2010], String(year));
    const geojson = toGeoJSON(visible);
    assert.equal(geojson.features.filter(f => f.geometry.type === 'Point').length, visible.stations.size);
    for (const station of visible.stations.values()) {
      assert.ok(Number.isInteger(station.properties.station_opening_year));
      assert.ok(station.properties.station_opening_year <= year);
    }
    for (const [id, edges] of visible.graph) {
      for (const edge of edges) {
        assert.ok(edge.openingYear <= year && edge.openingYear !== null);
        assert.ok(visible.stations.has(edge.to));
        assert.ok(network.graph.get(id).includes(edge));
      }
    }
  }
  assert.equal(forYear(network, null), network);
  assert.equal(forYear(network, null).stations.size, 250);
  assert.throws(() => forYear(network, 2009), /2010 to 2026/);
  assert.throws(() => forYear(network, 2027), /2010 to 2026/);
});

test('partial lines respect opening years at section boundaries and interchanges', () => {
  const first = forYear(network, 2011);
  const firstLines = toGeoJSON(first).features.filter(f => f.geometry.type === 'LineString');
  assert.equal(firstLines.length, 5);
  assert.ok(firstLines.every(f => f.properties.route_id === 'purple'));
  assert.equal(findRoute(first, 'ST019', 'ST024').geojson.features.length, 5);
  assert.throws(() => findRoute(forYear(network, 2015), 'ST008', 'ST019'), /No connected path/);
  assert.ok(findRoute(forYear(network, 2016), 'ST008', 'ST019').meters > 0);
  const interchange2016 = forYear(network, 2016).graph.get('ST015');
  assert.ok(interchange2016.every(edge => edge.feature.properties.route_id === 'purple'));
  assert.ok(forYear(network, 2017).graph.get('ST015').some(edge =>
    edge.feature.properties.route_id === 'green'));
});

test('later confirmed openings appear but forecasts do not count as actual openings', () => {
  const routes = year => new Set(toGeoJSON(forYear(network, year)).features
    .filter(f => f.properties.feature_type === 'route').map(f => f.properties.route_id));
  assert.equal(routes(2024).has('yellow'), false);
  assert.equal(routes(2025).has('yellow'), true);
  assert.equal(routes(2026).has('pink'), false);
  assert.deepEqual([...routes(2026)].sort(), ['green', 'purple', 'yellow']);
  assert.ok(routes(null).has('pink'));
  assert.ok(routes(null).has('sampige'));
});
