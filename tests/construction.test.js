const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const RailRouting = require('../routing.js');
const { phasePath } = require('../construction.js');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'datasets',
  'Bengaluru_metro_suburban_rail_upgraded.geojson'), 'utf8'));
const network = RailRouting.buildNetwork(data);
const routes = data.features.filter(feature => feature.properties.feature_type === 'route');

test('construction phases follow only their chosen line in both directions', () => {
  for (const route of routes) {
    const ids = route.properties.station_ids_in_order;
    for (const [from, to] of [[ids[0], ids.at(-1)], [ids.at(-1), ids[0]]]) {
      const result = phasePath(network, route, from, to);
      assert.deepEqual(result.stationIds, from === ids[0] ? ids : [...ids].reverse());
      assert.equal(result.features.length, ids.length - 1);
      assert.equal(result.openingYears.length, result.features.length);
      assert.ok(result.meters > 0);
      result.features.forEach((feature, i) => {
        assert.equal(feature.properties.route_id, route.properties.route_id);
        assert.equal(feature.properties.stroke, route.properties.stroke);
        assert.deepEqual(feature.geometry.coordinates[0],
          network.stations.get(result.stationIds[i]).geometry.coordinates);
        assert.deepEqual(feature.geometry.coordinates.at(-1),
          network.stations.get(result.stationIds[i + 1]).geometry.coordinates);
      });
    }
  }
});

test('phase rejects identical endpoints and a station from another line', () => {
  const purple = routes.find(route => route.properties.route_id === 'purple');
  assert.throws(() => phasePath(network, purple, 'ST001', 'ST001'), /different stations/);
  assert.throws(() => phasePath(network, purple, 'ST001', 'ST250'), /same line/);
});
