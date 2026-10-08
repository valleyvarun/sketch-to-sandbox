const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const RailRouting = require('../routing.js');
const ConstructionInfo = require('../construction-info.js');
const { phasePath } = require('../construction.js');

test('construction durations use years and remaining months with correct singular units', () => {
  for (const [months, expected] of [
    [0, '0 months'], [1, '1 month'], [11, '11 months'], [12, '1 year 0 months'],
    [13, '1 year 1 month'], [24, '2 years 0 months'], [25, '2 years 1 month'],
    [113, '9 years 5 months']
  ]) assert.equal(ConstructionInfo.formatDuration(months), expected);
  for (const invalid of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => ConstructionInfo.formatDuration(invalid), /non-negative whole months/);
  }
});

function fixture(system = 'metro') {
  const stations = new Map(['A', 'B', 'C', 'D', 'E'].map(id =>
    [id, { properties: { id } }]));
  const route = { properties: { system, route_id: system } };
  const phase = (number, ids, distances) => ({
    number, route, path: { stationIds: ids, segmentMeters: distances,
      openingYears: distances.map(() => null) }
  });
  return { network: { stations }, phases: [
    phase(9, ['A', 'B', 'C'], [1000, 2000]),
    phase(3, ['C', 'D', 'E'], [1000, 1000])
  ] };
}

test('sequential estimates use exact rates, charge shared stations once, and round each phase up', () => {
  const { network, phases } = fixture();
  const result = ConstructionInfo.calculate(phases, network);
  assert.deepEqual(result.phases.map(phase => ({
    number: phase.number, km: phase.km, stations: phase.stationCount,
    cost: phase.cost, months: phase.months, start: phase.startMonth, end: phase.endMonth
  })), [
    { number: 9, km: 3, stations: 3, cost: 960, months: 25, start: 0, end: 25 },
    { number: 3, km: 2, stations: 2, cost: 640, months: 23, start: 25, end: 48 }
  ]);
  assert.equal(result.totalCost, 1600);
  assert.equal(result.totalMonths, 48);
  assert.deepEqual(result.phases[0].completion, { year: 2028, label: 'Feb 2028' });
  assert.deepEqual(result.completion, { year: 2030, label: 'Jan 2030' });
});

test('suburban assumptions are substantially cheaper and faster than Metro', () => {
  const metro = fixture();
  const suburban = fixture('suburban');
  const metroResult = ConstructionInfo.calculate(metro.phases, metro.network);
  const result = ConstructionInfo.calculate(suburban.phases, suburban.network);
  assert.equal(result.phases[0].cost, 180);
  assert.equal(result.phases[0].months, 9);
  assert.equal(result.totalCost, 300);
  assert.equal(result.totalMonths, 17);
  assert.ok(result.totalCost < metroResult.totalCost / 4);
  assert.ok(result.totalMonths < metroResult.totalMonths / 2);
});

test('existing stations and segments, including reversed duplicate track, are not charged twice', () => {
  const { network, phases } = fixture();
  network.stations.get('A').properties.station_opening_year = 2026;
  network.stations.get('B').properties.station_opening_year = 2015;
  phases[0].path.openingYears[0] = 2026;
  const reverse = { ...phases[0], number: 10, path: {
    stationIds: ['C', 'B', 'A'], segmentMeters: [2000, 1000], openingYears: [null, 2026]
  } };
  const result = ConstructionInfo.calculate([phases[0], reverse], network);
  assert.equal(result.phases[0].km, 2);
  assert.equal(result.phases[0].stationCount, 1);
  assert.equal(result.phases[0].cost, 540);
  assert.equal(result.phases[1].cost, 0);
  assert.equal(result.phases[1].months, 0);
  assert.equal(result.phases[1].stationCount, 0);
  assert.deepEqual(result.phases[1].newSegments, []);
});

test('Metro assumptions have a reproducible broad check against CSV Phase 1', () => {
  const ids = Array.from({ length: 41 }, (_, i) => String(i));
  const network = { stations: new Map(ids.map(id => [id, { properties: {} }])) };
  const result = ConstructionInfo.calculate([{
    number: 1, route: { properties: { system: 'metro', route_id: 'check' } },
    path: { stationIds: ids, segmentMeters: Array(40).fill(42300 / 40), openingYears: Array(40).fill(null) }
  }], network);
  assert.ok(Math.abs(result.totalCost - 13406) < 1e-8);
  assert.equal(result.totalMonths, 113);
});

test('invalid construction input fails explicitly', () => {
  const { network, phases } = fixture();
  assert.throws(() => ConstructionInfo.calculate([], network), /at least one phase/);
  phases[0].path.segmentMeters[0] = NaN;
  assert.throws(() => ConstructionInfo.calculate(phases, network), /Invalid distance/);
  phases[0].path.segmentMeters = [];
  assert.throws(() => ConstructionInfo.calculate(phases, network), /invalid construction data/);
});

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'datasets',
  'Bengaluru_metro_suburban_rail_upgraded.geojson'), 'utf8'));
const network = RailRouting.buildNetwork(data);
const blue = data.features.find(feature => feature.properties.route_id === 'blue' &&
  feature.properties.feature_type === 'route');
const phases = [
  { number: 3, route: blue, path: phasePath(network, blue, 'ST100', 'ST106') },
  { number: 4, route: blue, path: phasePath(network, blue, 'ST106', 'ST110') }
];

test('projection opens only completed segments, preserves exact paths and all recorded years, and never mutates source data', () => {
  const original = structuredClone(network);
  const report = ConstructionInfo.calculate(phases, network);
  const projected = ConstructionInfo.projectNetwork(network, report);
  for (let year = 2010; year <= 2026; year++) {
    assert.deepEqual(RailRouting.forYear(projected, year), RailRouting.forYear(network, year));
  }
  const firstYear = report.phases[0].completion.year;
  const lastYear = report.completion.year;
  assert.ok(lastYear > firstYear);
  assert.equal(RailRouting.forYear(projected, firstYear - 1).stations.has('ST100'), false);
  const first = RailRouting.forYear(projected, firstYear);
  assert.equal(first.stations.has('ST106'), true);
  assert.equal(first.stations.has('ST107'), false, 'shared endpoint does not unlock the next segment');
  const firstRoute = RailRouting.findRoute(first, 'ST100', 'ST106');
  assert.deepEqual(firstRoute.geojson.features, phases[0].path.features);
  assert.equal(firstRoute.meters, phases[0].path.meters);
  const complete = RailRouting.forYear(projected, lastYear);
  assert.deepEqual(RailRouting.findRoute(complete, 'ST100', 'ST110').stationIds,
    [...phases[0].path.stationIds, ...phases[1].path.stationIds.slice(1)]);
  assert.equal(complete.stations.has('ST111'), false);
  assert.equal(complete.stations.get('ST106').properties.station_opening_year, firstYear);
  assert.equal(complete.stations.get('ST100').properties.simulated_opening, true);
  assert.equal(complete.stations.get('ST100').properties.station_opening_date, null);
  assert.equal(RailRouting.forYear(projected, null), projected, 'final plan includes all proposals');
  assert.throws(() => RailRouting.forYear(projected, lastYear + 1), /Choose a year/);
  assert.deepEqual(network, original);
});

test('explicit interchange connections open only when both endpoints are available', () => {
  const transfer = data.features.find(feature =>
    ['walking_transfer', 'map_interchange'].includes(feature.properties.feature_type) &&
    [feature.properties.from_station_id, feature.properties.to_station_id].every(id =>
      !network.stations.get(id).properties.station_opening_year));
  assert.ok(transfer);
  const { from_station_id: from, to_station_id: to } = transfer.properties;
  const report = { phases: [
    { newStationIds: [from], newSegments: [], completion: { year: 2028 } },
    { newStationIds: [to], newSegments: [], completion: { year: 2030 } }
  ], completion: { year: 2030 } };
  const projected = ConstructionInfo.projectNetwork(network, report);
  assert.equal(RailRouting.forYear(projected, 2028).graph.get(from).some(edge => edge.to === to), false);
  const completed = RailRouting.forYear(projected, 2030);
  assert.equal(completed.graph.get(from).some(edge => edge.to === to), true);
  assert.equal(completed.graph.get(to).some(edge => edge.to === from), true);
  assert.deepEqual(RailRouting.findRoute(completed, from, to).stationIds, [from, to]);
});

test('crossing phases share an interior station cost but open their own track only at their completion', () => {
  const red = data.features.find(feature => feature.properties.feature_type === 'route' &&
    feature.properties.route_id === 'red');
  const redPhase = { number: 4, route: red, path: phasePath(network, red, 'ST153', 'ST170') };
  assert.ok(redPhase.path.stationIds.slice(1, -1).includes('ST103'));
  const report = ConstructionInfo.calculate([phases[0], redPhase], network);
  assert.ok(report.phases[0].newStationIds.includes('ST103'));
  assert.ok(!report.phases[1].newStationIds.includes('ST103'), 'no second charge for the shared station');
  const projected = ConstructionInfo.projectNetwork(network, report);
  const first = RailRouting.forYear(projected, report.phases[0].completion.year);
  assert.ok(first.graph.get('ST103').some(edge => edge.feature.properties.route_id === 'blue'));
  assert.ok(!first.graph.get('ST103').some(edge => edge.feature.properties.route_id === 'red'));
  const complete = RailRouting.forYear(projected, report.completion.year);
  const journey = RailRouting.findRoute(complete, 'ST153', 'ST170');
  assert.deepEqual(journey.geojson.features, redPhase.path.features);
  assert.equal(complete.stations.get('ST103').properties.station_opening_year, report.phases[0].completion.year);
});
