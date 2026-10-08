const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate, metroFare, metroSlabs, constants, formatDuration } = require('../travel-info.js');

test('Travel durations use hours and minutes with tenths preserved and rounding carried into hours', () => {
  for (const [minutes, expected] of [
    [0, '0 min'], [0.5, '0.5 min'], [59.9, '59.9 min'], [59.96, '1 hr 0 min'],
    [60, '1 hr 0 min'], [90.5, '1 hr 30.5 min'], [119.96, '2 hr 0 min'],
    [150, '2 hr 30 min']
  ]) assert.equal(formatDuration(minutes), expected);
  for (const invalid of [-1, NaN, Infinity]) assert.throws(() => formatDuration(invalid), /non-negative minutes/);
});

function route(segments) {
  return {
    stationIds: Array.from({ length: segments.length + 1 }, (_, i) => `S${i}`),
    segmentMeters: segments.map(segment => segment[2]),
    geojson: { features: segments.map(([system, line]) => ({
      properties: system === 'walking' ? { feature_type: 'walking_transfer' } :
        { feature_type: 'route', route_id: line, name: line, system }
    })) }
  };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('dated official Metro fare slabs include each upper boundary and use unrounded distance', () => {
  assert.equal(metroFare(0), 10);
  for (const [i, [limit, fare]] of metroSlabs.entries()) {
    if (!Number.isFinite(limit)) continue;
    assert.equal(metroFare(limit), fare);
    assert.equal(metroFare(limit - 0.000001), fare);
    assert.equal(metroFare(limit + 0.000001), metroSlabs[i + 1][1]);
  }
  assert.equal(metroFare(100), 90);
  for (const km of [-1, NaN, Infinity]) assert.throws(() => metroFare(km), /non-negative/);
});

test('same-line Metro trip uses exact distance, intermediate stops only, and one fare', () => {
  const result = calculate(route([['metro', 'purple', 1000], ['metro', 'purple', 1000]]));
  assert.equal(result.totalKm, 2);
  assert.equal(result.stationCount, 3);
  assert.equal(result.lineChanges, 0);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].km, 2);
  assert.equal(result.lines[0].from, 'S0');
  assert.equal(result.lines[0].to, 'S2');
  assert.equal(result.stopMinutes, constants.metroStopMinutes);
  assert.equal(result.runningMinutes, 3);
  assert.equal(result.totalMinutes, 3.5);
  assert.equal(result.totalCost, 10);
});

test('Metro line switches add transfer time but not a new fare or duplicate station stop', () => {
  const result = calculate(route([
    ['metro', 'purple', 1000], ['metro', 'green', 1000], ['metro', 'purple', 1000]
  ]));
  assert.deepEqual(result.lines.map(line => line.name), ['purple', 'green', 'purple']);
  assert.equal(result.lineChanges, 2);
  assert.equal(result.sameSystemTransfers, 2);
  assert.equal(result.stopMinutes, 0);
  assert.equal(result.transferMinutes, 10);
  assert.equal(result.totalMinutes, 14.5);
  assert.equal(result.metroCost, 20);
  assert.equal(result.tickets.length, 1);
});

test('mixed trip includes walking, longer system transfer, suburban stops and separate fares', () => {
  const result = calculate(route([
    ['metro', 'purple', 1000], ['walking', null, 450],
    ['suburban', 'sampige', 1000], ['suburban', 'sampige', 1000]
  ]));
  assert.equal(result.lineChanges, 1);
  assert.equal(result.sameSystemTransfers, 0);
  assert.equal(result.crossSystemTransfers, 1);
  assert.equal(result.transferMinutes, 12);
  assert.equal(result.walkingMinutes, 6);
  assert.equal(result.stopMinutes, 1);
  near(result.totalMinutes, 22.9);
  near(result.totalKm, 3.45);
  assert.equal(result.stationCount, 5);
  assert.equal(result.metroCost, 10);
  assert.equal(result.suburbanCost, 10);
  assert.equal(result.totalCost, 20);
  assert.equal(result.lines[0].from, 'S0');
  assert.equal(result.lines[0].to, 'S1');
  assert.equal(result.lines[1].from, 'S2');
  assert.equal(result.lines[1].to, 'S4');
});

test('external walking starts a new paid journey even when returning to the same line', () => {
  const result = calculate(route([
    ['metro', 'purple', 1000], ['walking', null, 450], ['metro', 'purple', 1000]
  ]));
  assert.equal(result.lineChanges, 0);
  assert.equal(result.sameSystemTransfers, 1);
  assert.equal(result.totalMinutes, 14);
  assert.equal(result.metroCost, 20);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].to, 'S1');
  assert.equal(result.lines[1].from, 'S2');
});

test('walking-only trip has no rail fare and initial/final walking does not add transfer penalties', () => {
  const walk = calculate(route([['walking', null, 450]]));
  assert.equal(walk.totalMinutes, 6);
  assert.equal(walk.totalCost, 0);
  assert.deepEqual(walk.lines, []);
  const train = calculate(route([
    ['walking', null, 450], ['suburban', 'sampige', 6200], ['walking', null, 450]
  ]));
  assert.equal(train.transferMinutes, 0);
  assert.equal(train.stopMinutes, 0);
  assert.equal(train.suburbanCost, 13);
  assert.equal(train.totalCost, 13);
  near(train.totalMinutes, 19.44);
});

test('missing distances and unknown systems fail explicitly', () => {
  const invalid = route([['metro', 'purple', 1]]);
  invalid.segmentMeters = [];
  assert.throws(() => calculate(invalid), /distance for every/);
  assert.throws(() => calculate(route([['bus', 'bus', 1]])), /Unknown rail system/);
  assert.throws(() => calculate(route([['metro', 'purple', NaN]])), /Invalid route segment/);
});

test('real routes keep reporting consistent with routing distances and line changes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const routing = require('../routing.js');
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'datasets',
    'Bengaluru_metro_suburban_rail_upgraded.geojson'), 'utf8'));
  const network = routing.buildNetwork(data);
  for (const id of network.stations.keys()) {
    const trip = routing.findRoute(network, 'ST001', id === 'ST001' ? 'ST250' : id);
    const info = calculate(trip);
    near(info.totalKm * 1000, trip.meters);
    assert.equal(info.lineChanges, trip.lineChanges);
    assert.equal(info.stationCount, new Set(trip.stationIds).size);
    assert.ok(Number.isFinite(info.totalMinutes));
    assert.ok(Number.isInteger(info.totalCost));
    assert.equal(info.totalCost, info.metroCost + info.suburbanCost);
  }
});
