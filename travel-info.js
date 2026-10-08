const TravelInfo = (() => {
  const constants = {
    metroSpeedKmh: 40,
    suburbanSpeedKmh: 50,
    walkingSpeedKmh: 4.5,
    metroStopMinutes: 0.5,
    suburbanStopMinutes: 1,
    sameSystemTransferMinutes: 5,
    crossSystemTransferMinutes: 12,
    suburbanMinimumFare: 10,
    suburbanFarePerKm: 2
  };
  const metroSlabs = [
    [2, 10], [4, 20], [6, 30], [8, 40], [10, 50],
    [15, 60], [20, 70], [25, 80], [30, 90], [Infinity, 90]
  ];
  const fareSource = 'https://english.bmrc.co.in:8282/English/uploads/news/english/fileuploads/' +
    '1739069224825$@!!Media%20Brief%20-English-%20Fin%2008.02.2025%20(1).pdf';

  function metroFare(km) {
    if (!Number.isFinite(km) || km < 0) throw new Error('Metro fare requires a non-negative distance.');
    return metroSlabs.find(([limit]) => km <= limit)[1];
  }

  function calculate(route) {
    const features = route.geojson.features;
    if (!route.segmentMeters || route.segmentMeters.length !== features.length) {
      throw new Error('Travel details require a distance for every route segment.');
    }
    const km = { metro: 0, suburban: 0, walking: 0 };
    const lines = [];
    const tickets = [];
    let ticket = null;
    let lastRail = null;
    let previous = null;
    let walked = false;
    let stopMinutes = 0;
    let sameSystemTransfers = 0;
    let crossSystemTransfers = 0;
    let lineChanges = 0;
    for (const [i, feature] of features.entries()) {
      const meters = route.segmentMeters[i];
      if (!Number.isFinite(meters) || meters < 0) throw new Error('Invalid route segment distance.');
      const properties = feature.properties;
      if (properties.feature_type !== 'route') {
        km.walking += meters / 1000;
        ticket = null;
        previous = null;
        walked = true;
        continue;
      }
      const system = properties.system;
      if (system !== 'metro' && system !== 'suburban') throw new Error(`Unknown rail system: ${system}.`);
      km[system] += meters / 1000;
      if (lastRail) {
        if (properties.route_id !== lastRail.route_id) lineChanges++;
        if (properties.route_id !== lastRail.route_id || walked) {
          if (system === lastRail.system) sameSystemTransfers++;
          else crossSystemTransfers++;
        }
      }
      if (previous?.route_id === properties.route_id) {
        stopMinutes += system === 'metro' ? constants.metroStopMinutes : constants.suburbanStopMinutes;
      }
      if (!previous || previous.route_id !== properties.route_id) {
        lines.push({
          name: properties.name, system, color: properties.stroke, km: 0,
          from: route.stationIds[i], to: route.stationIds[i + 1]
        });
      }
      lines[lines.length - 1].km += meters / 1000;
      lines[lines.length - 1].to = route.stationIds[i + 1];
      if (!ticket || ticket.system !== system) {
        ticket = { system, km: 0 };
        tickets.push(ticket);
      }
      ticket.km += meters / 1000;
      lastRail = previous = properties;
      walked = false;
    }
    const runningMinutes = 60 * (km.metro / constants.metroSpeedKmh + km.suburban / constants.suburbanSpeedKmh);
    const walkingMinutes = 60 * km.walking / constants.walkingSpeedKmh;
    const transferMinutes = sameSystemTransfers * constants.sameSystemTransferMinutes +
      crossSystemTransfers * constants.crossSystemTransferMinutes;
    let metroCost = 0;
    let suburbanCost = 0;
    for (const leg of tickets) {
      if (leg.system === 'metro') metroCost += metroFare(leg.km);
      else suburbanCost += Math.max(constants.suburbanMinimumFare, Math.ceil(leg.km * constants.suburbanFarePerKm));
    }
    return {
      km, lines, tickets, lineChanges, sameSystemTransfers, crossSystemTransfers,
      stationCount: new Set(route.stationIds).size,
      totalKm: km.metro + km.suburban + km.walking,
      runningMinutes, walkingMinutes, stopMinutes, transferMinutes,
      totalMinutes: runningMinutes + walkingMinutes + stopMinutes + transferMinutes,
      metroCost, suburbanCost, totalCost: metroCost + suburbanCost
    };
  }

  function formatDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error('Travel duration requires non-negative minutes.');
    const tenths = Math.round(minutes * 10);
    const hours = Math.floor(tenths / 600);
    const remaining = (tenths % 600) / 10;
    return `${hours ? hours + ' hr ' : ''}${remaining} min`;
  }

  function create() {
    const result = document.getElementById('travelResult');
    const formulas = document.getElementById('travelFormulas');
    formulas.replaceChildren();
    function paragraph(parent, text) {
      const element = document.createElement('p');
      element.textContent = text;
      parent.appendChild(element);
    }
    function notation(parent, expression) {
      for (const part of expression.split(/(_[a-z0-9]+)/g)) {
        const element = document.createElement(part.startsWith('_') ? 'sub' : 'span');
        element.textContent = part.startsWith('_') ? part.slice(1) : part;
        parent.appendChild(element);
      }
    }
    function equation(expression) {
      const element = document.createElement('p');
      element.className = 'travel-equation';
      notation(element, expression);
      formulas.appendChild(element);
    }
    function table(parent, rows) {
      const element = document.createElement('table');
      for (const [label, value] of rows) {
        const row = document.createElement('tr');
        const heading = document.createElement('th');
        heading.setAttribute('scope', 'row');
        heading.textContent = label;
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.appendChild(heading);
        row.appendChild(cell);
        element.appendChild(row);
      }
      parent.appendChild(element);
    }
    const heading = document.createElement('h3');
    heading.textContent = 'Formulas and constants';
    formulas.appendChild(heading);
    paragraph(formulas, 'First minimize the number of line changes, then minimize the distance travelled.');
    equation('D = D_metro + D_suburban + D_walking');
    equation('T = T_move + T_stop + T_change');
    table(formulas, [
      ['Earth radius', '6,371 km'],
      ['Metro speed', `${constants.metroSpeedKmh} km/h`],
      ['Suburban speed', `${constants.suburbanSpeedKmh} km/h`],
      ['Walking speed', `${constants.walkingSpeedKmh} km/h`],
      ['Metro stop', `${constants.metroStopMinutes} min`],
      ['Suburban stop', `${constants.suburbanStopMinutes} min`],
      ['Same-system transfer', `${constants.sameSystemTransferMinutes} min`],
      ['Metro / suburban transfer', `${constants.crossSystemTransferMinutes} min`]
    ]);
    paragraph(formulas, 'Time constants are assumptions. Transfers replace stops; walking time is additional. Initial waits and delays are excluded.');
    equation('C = C_metro + C_suburban');
    table(formulas, [
      ['Suburban minimum', `INR ${constants.suburbanMinimumFare}`],
      ['Suburban rate', `INR ${constants.suburbanFarePerKm}/km`]
    ]);
    paragraph(formulas, 'Suburban fare assumption (not official).');
    const fareHeading = document.createElement('h4');
    fareHeading.textContent = 'Metro fare slabs';
    formulas.appendChild(fareHeading);
    table(formulas, metroSlabs.map(([limit, fare], i) => [
      Number.isFinite(limit) ? `${i ? '> ' + metroSlabs[i - 1][0] : '0'} to ${limit} km` : '> 30 km',
      `INR ${fare}`
    ]));
    const source = document.createElement('a');
    source.href = fareSource;
    source.textContent = 'BMRCL fare source';
    formulas.appendChild(source);
    paragraph(formulas, 'Effective 9 February 2025. Not confirmed current in October 2026. Used for all map years.');
    paragraph(formulas, 'Mapped-distance estimates, not station-pair ticket quotes. Future-line fares are extrapolated.');

    return {
      clear() { result.replaceChildren(); },
      show(route, from, to, stationName) {
        const info = calculate(route);
        result.replaceChildren();
        table(result, [
          ['From', from], ['To', to],
          ['Distance', `${info.totalKm.toFixed(2)} km`],
          ['Estimated time', formatDuration(info.totalMinutes)],
          ['Stations (incl. endpoints)', info.stationCount],
          ['Line changes', info.lineChanges],
          ['Total cost (estimate)', `INR ${info.totalCost}`],
          ['Metro fare estimate', `INR ${info.metroCost}`],
          ['Suburban fare estimate', `INR ${info.suburbanCost}`]
        ]);
        const lineHeading = document.createElement('h3');
        lineHeading.textContent = 'Lines taken, in order';
        result.appendChild(lineHeading);
        const list = document.createElement('ol');
        list.className = 'travel-journey';
        for (const line of info.lines) {
          const item = document.createElement('li');
          item.className = 'travel-leg';
          const track = document.createElement('div');
          track.className = 'journey-track';
          track.style.color = line.color;
          track.setAttribute('data-system', line.system);
          track.setAttribute('aria-hidden', 'true');
          const start = document.createElement('span');
          start.className = 'journey-start';
          start.textContent = stationName(line.from);
          const label = document.createElement('span');
          label.className = 'journey-line';
          label.textContent = `${line.name} (${line.km.toFixed(2)} km)`;
          const end = document.createElement('span');
          end.className = 'journey-end';
          end.textContent = stationName(line.to);
          item.appendChild(track);
          item.appendChild(start);
          item.appendChild(label);
          item.appendChild(end);
          list.appendChild(item);
        }
        result.appendChild(list);
        if (!info.lines.length) paragraph(result, 'Walking connection only; no train boarding.');
        paragraph(result, `Time breakdown: ${formatDuration(info.runningMinutes)} running + ${formatDuration(info.stopMinutes)} stops + ${formatDuration(info.walkingMinutes)} walking + ${formatDuration(info.transferMinutes)} transfers.`);
        paragraph(result, `${info.sameSystemTransfers} same-system and ${info.crossSystemTransfers} Metro/suburban transfers. Walking distance: ${info.km.walking.toFixed(2)} km.`);
        paragraph(result, 'Planning estimate, not a ticket quote or live journey time. Metro slabs are dated 9 February 2025; current fares are unverified. Suburban fares and future-line fares are estimates. See the assumptions below.');
        return info;
      }
    };
  }
  return { constants, metroSlabs, metroFare, calculate, formatDuration, create };
})();

if (typeof module !== 'undefined') module.exports = TravelInfo;
