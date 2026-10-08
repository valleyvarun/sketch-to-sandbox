const ConstructionInfo = (() => {
  const startYear = 2026;
  const inrPerUsd = 90;
  const kmPerMile = 1.609344;
  const constants = {
    metro: { lineCost: 220, stationCost: 100, setupMonths: 18, lineMonths: 1.5, stationMonths: 0.75 },
    suburban: { lineCost: 40, stationCost: 20, setupMonths: 6, lineMonths: 0.5, stationMonths: 0.25 }
  };
  const opened = year => Number.isInteger(year) && year <= startYear;
  const segmentKey = (route, from, to) => JSON.stringify([route, ...[from, to].sort()]);

  function completion(months) {
    // Month zero is January 2026; the boundary after 12 months is January 2027.
    const year = startYear + Math.floor(months / 12);
    const month = months % 12;
    return { year, label: `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month]} ${year}` };
  }

  function calculate(phases, network) {
    if (!phases.length) throw new Error('Add at least one phase before building.');
    const stations = new Set([...network.stations].filter(([, station]) =>
      opened(station.properties.station_opening_year)).map(([id]) => id));
    const segments = new Set();
    let totalCost = 0;
    let totalMonths = 0;
    const estimates = phases.map(phase => {
      const { path, route, number } = phase;
      const rates = constants[route.properties.system];
      if (!rates || path.stationIds.length < 2 ||
          path.segmentMeters?.length !== path.stationIds.length - 1) {
        throw new Error(`Phase ${number} has invalid construction data.`);
      }
      const newStationIds = path.stationIds.filter(id => {
        if (!network.stations.has(id)) throw new Error(`Unknown construction station: ${id}.`);
        if (stations.has(id)) return false;
        stations.add(id);
        return true;
      });
      let km = 0;
      const newSegments = [];
      path.segmentMeters.forEach((meters, i) => {
        if (!Number.isFinite(meters) || meters <= 0) throw new Error(`Invalid distance in Phase ${number}.`);
        const key = segmentKey(route.properties.route_id, path.stationIds[i], path.stationIds[i + 1]);
        if (opened(path.openingYears[i]) || segments.has(key)) return;
        segments.add(key);
        newSegments.push(key);
        km += meters / 1000;
      });
      const stationCount = newStationIds.length;
      const cost = km * rates.lineCost + stationCount * rates.stationCost;
      const months = km || stationCount ?
        Math.ceil(rates.setupMonths + km * rates.lineMonths + stationCount * rates.stationMonths) : 0;
      const startMonth = totalMonths;
      totalCost += cost;
      totalMonths += months;
      return { number, km, stationCount, cost, months, startMonth, endMonth: totalMonths,
        completion: completion(totalMonths), newStationIds, newSegments };
    });
    return { phases: estimates, totalCost, totalMonths, completion: completion(totalMonths) };
  }

  function projectNetwork(network, report) {
    const stationYears = new Map();
    const segmentYears = new Map();
    for (const phase of report.phases) {
      phase.newStationIds.forEach(id => stationYears.set(id, phase.completion.year));
      phase.newSegments.forEach(key => segmentYears.set(key, phase.completion.year));
    }
    const stations = new Map([...network.stations].map(([id, station]) => [id, stationYears.has(id) ? {
      ...station, properties: { ...station.properties, station_opening_year: stationYears.get(id),
        station_opening_date: null, simulated_opening: true }
    } : station]));
    const graph = new Map([...network.graph].map(([from, edges]) => [from, edges.map(edge => {
      if (opened(edge.openingYear)) return edge;
      let openingYear;
      if (edge.feature.properties.feature_type === 'route') {
        openingYear = segmentYears.get(segmentKey(edge.feature.properties.route_id, from, edge.to));
      } else {
        const fromYear = stations.get(from).properties.station_opening_year;
        const toYear = stations.get(edge.to).properties.station_opening_year;
        const available = (id, year) => opened(year) || stationYears.has(id);
        if (available(from, fromYear) && available(edge.to, toYear)) {
          openingYear = Math.max(fromYear, toYear);
        }
      }
      return { ...edge, openingYear: openingYear ?? null };
    })]));
    return { stations, graph, maxYear: Math.max(startYear, report.completion.year) };
  }

  function formatDuration(months) {
    if (!Number.isSafeInteger(months) || months < 0) throw new Error('Construction duration requires non-negative whole months.');
    const years = Math.floor(months / 12);
    const remaining = months % 12;
    return `${years ? years + (years === 1 ? ' year ' : ' years ') : ''}${remaining} ${remaining === 1 ? 'month' : 'months'}`;
  }

  function create() {
    const result = document.getElementById('constructionResult');
    const estimate = document.getElementById('constructionEstimate');
    const formulas = document.getElementById('constructionFormulas');
    const currency = document.getElementById('estimateCurrency');
    const distance = document.getElementById('estimateDistance');
    const units = { usd: false, miles: false };
    let currentReport = null;
    const cost = crore => units.usd ?
      `USD ${(crore * 10000000 / inrPerUsd / 1000000).toFixed(2)} million` :
      `INR ${crore.toFixed(2)} crore`;
    const length = km => units.miles ? `${(km / kmPerMile).toFixed(2)} mi` : `${km.toFixed(2)} km`;
    function text(parent, tag, value) {
      const element = document.createElement(tag);
      element.textContent = value;
      parent.appendChild(element);
      return element;
    }
    function table(parent, rows) {
      const table = document.createElement('table');
      for (const [label, value] of rows) {
        const row = document.createElement('tr');
        text(row, 'th', label).setAttribute('scope', 'row');
        text(row, 'td', value);
        table.appendChild(row);
      }
      parent.appendChild(table);
    }
    formulas.replaceChildren();
    table(formulas, [
      ['Start', 'January 2026'],
      ['Metro line', `INR ${constants.metro.lineCost} crore/km`],
      ['Metro station', `INR ${constants.metro.stationCost} crore`],
      ['Metro setup', `${constants.metro.setupMonths} months/phase`],
      ['Metro line time', `${constants.metro.lineMonths} months/km`],
      ['Metro station time', `${constants.metro.stationMonths} months/station`],
      ['Suburban line', `INR ${constants.suburban.lineCost} crore/km`],
      ['Suburban station', `INR ${constants.suburban.stationCost} crore`],
      ['Suburban setup', `${constants.suburban.setupMonths} months/phase`],
      ['Suburban line time', `${constants.suburban.lineMonths} months/km`],
      ['Suburban station time', `${constants.suburban.stationMonths} months/station`]
    ]);
    text(formulas, 'p', 'Illustrative assumptions, not official estimates. Line rates exclude station costs; suburban rates assume existing corridors.');
    text(formulas, 'p', 'Sequential phases in added order. Months round up.');
    function render() {
      result.replaceChildren();
      if (!currentReport) return;
      const report = currentReport;
      for (const phase of report.phases) {
        text(result, 'h4', `Phase ${phase.number}`);
        table(result, [
          ['New line', length(phase.km)],
          ['New stations', String(phase.stationCount)],
          ['Cost', cost(phase.cost)],
          ['Duration', formatDuration(phase.months)],
          ['Complete', phase.completion.label]
        ]);
      }
      text(result, 'h3', 'Total');
      table(result, [
        ['Cost', cost(report.totalCost)],
        ['Duration', formatDuration(report.totalMonths)],
        ['Complete', report.completion.label]
      ]);
      if (units.usd) text(result, 'p', `Assumed exchange rate: INR ${inrPerUsd} = USD 1 (not live).`);
      text(result, 'h3', 'Timeline');
      const timeline = document.createElement('ol');
      timeline.className = 'construction-timeline';
      timeline.setAttribute('aria-label', 'Sequential phase completion timeline');
      for (let year = startYear; year <= report.completion.year; year++) {
        const item = document.createElement('li');
        text(item, 'strong', String(year));
        if (year === startYear) text(item, 'p', 'Jan: construction starts');
        report.phases.filter(phase => phase.completion.year === year).forEach(phase => {
          text(item, 'p', `${phase.completion.label}: Phase ${phase.number} complete`);
        });
        timeline.appendChild(item);
      }
      result.appendChild(timeline);
    }
    for (const [button, unit] of [[currency, 'usd'], [distance, 'miles']]) {
      button.disabled = false;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        units[unit] = !units[unit];
        button.setAttribute('aria-pressed', String(units[unit]));
        render();
      });
    }
    return {
      clear() {
        currentReport = null;
        result.replaceChildren();
        estimate.hidden = true;
      },
      show(report) {
        currentReport = report;
        estimate.hidden = false;
        estimate.open = true;
        render();
        estimate.scrollIntoView({ block: 'start' });
      }
    };
  }
  return { constants, startYear, calculate, projectNetwork, formatDuration, create };
})();

if (typeof module !== 'undefined') module.exports = ConstructionInfo;
