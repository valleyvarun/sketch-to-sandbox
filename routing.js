const RailRouting = (() => {
  function distance(a, b) {
    const radians = Math.PI / 180;
    const lat = (b[1] - a[1]) * radians;
    const lng = (b[0] - a[0]) * radians;
    const h = Math.sin(lat / 2) ** 2 +
      Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(lng / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
  }

  const samePosition = (a, b) => a[0] === b[0] && a[1] === b[1];

  function buildNetwork(data) {
    const stations = new Map(data.features
      .filter(feature => feature.geometry.type === 'Point')
      .map(feature => [feature.properties.id, feature]));
    const graph = new Map([...stations.keys()].map(id => [id, []]));

    function connect(from, to, coordinates, properties, openingYear) {
      if (!stations.has(from) || !stations.has(to) || coordinates.length < 2 ||
          !samePosition(coordinates[0], stations.get(from).geometry.coordinates) ||
          !samePosition(coordinates.at(-1), stations.get(to).geometry.coordinates)) {
        throw new Error(`Invalid station connection in ${properties.id}.`);
      }
      const meters = coordinates.slice(1).reduce((sum, point, i) =>
        sum + distance(coordinates[i], point), 0);
      const feature = { type: 'Feature', properties,
        geometry: { type: 'LineString', coordinates } };
      graph.get(from).push({ to, meters, feature, openingYear, reverse: false });
      graph.get(to).push({ to: from, meters, feature, openingYear, reverse: true });
    }

    function connectionYear(fromYear, toYear) {
      return Number.isInteger(fromYear) && Number.isInteger(toYear) ?
        Math.max(fromYear, toYear) : null;
    }

    for (const feature of data.features) {
      const properties = feature.properties;
      if (properties.feature_type === 'route') {
        const coordinates = feature.geometry.coordinates;
        const ids = properties.station_ids_in_order;
        let previousIndex = 0;
        const indices = ids.map(id => {
          const station = stations.get(id);
          // Use the stored station order and exact route vertices, never straight-line shortcuts.
          const index = station ? coordinates.findIndex((point, i) =>
            i >= previousIndex && samePosition(point, station.geometry.coordinates)) : -1;
          if (index < 0) throw new Error(`Station ${id} is missing from route ${properties.id}.`);
          previousIndex = index;
          return index;
        });
        const openingYear = id => stations.get(id).properties.station_line_history
          ?.find(history => history.route_id === properties.route_id)?.station_opening_year;
        for (let i = 1; i < ids.length; i++) {
          connect(ids[i - 1], ids[i], coordinates.slice(indices[i - 1], indices[i] + 1), properties,
            connectionYear(openingYear(ids[i - 1]), openingYear(ids[i])));
        }
      } else if (properties.from_station_id && properties.to_station_id) {
        connect(properties.from_station_id, properties.to_station_id,
          feature.geometry.coordinates, properties,
          connectionYear(stations.get(properties.from_station_id)?.properties.station_opening_year,
            stations.get(properties.to_station_id)?.properties.station_opening_year));
      }
    }
    return { stations, graph };
  }

  function forYear(network, year) {
    if (year === null) return network;
    const maxYear = network.maxYear ?? 2026;
    if (!Number.isInteger(year) || year < 2010 || year > maxYear) {
      throw new Error(`Choose a year from 2010 to ${maxYear}, or final plan.`);
    }
    const stations = new Map([...network.stations].filter(([, station]) => {
      const openingYear = station.properties.station_opening_year;
      return Number.isInteger(openingYear) && openingYear <= year;
    }));
    const graph = new Map([...stations.keys()].map(id => [id,
      network.graph.get(id).filter(edge => stations.has(edge.to) &&
        Number.isInteger(edge.openingYear) && edge.openingYear <= year)
    ]));
    return { stations, graph };
  }

  function toGeoJSON(network) {
    const lines = [...network.graph.values()].flatMap(edges =>
      edges.filter(edge => !edge.reverse).map(edge => edge.feature));
    return { type: 'FeatureCollection', features: [...lines, ...network.stations.values()] };
  }

  function findRoute(network, from, to) {
    if (!network.stations.has(from) || !network.stations.has(to)) {
      throw new Error('Choose both stations from the search results or the map.');
    }
    if (from === to) throw new Error('Choose two different stations.');

    const states = new Map();
    function stateFor(station, line) {
      if (!states.has(station)) states.set(station, new Map());
      const lines = states.get(station);
      if (!lines.has(line)) {
        lines.set(line, { station, line, lineChanges: Infinity, meters: Infinity, visited: false });
      }
      return lines.get(line);
    }
    const better = (a, b) => a.lineChanges < b.lineChanges ||
      (a.lineChanges === b.lineChanges && a.meters < b.meters);
    const start = stateFor(from, null);
    start.lineChanges = 0;
    start.meters = 0;
    const remaining = new Set([start]);
    let destination;
    while (remaining.size) {
      let current;
      for (const state of remaining) {
        if (!current || better(state, current)) current = state;
      }
      if (current.station === to) {
        destination = current;
        break;
      }
      remaining.delete(current);
      current.visited = true;
      for (const edge of network.graph.get(current.station)) {
        // Walking connections retain the last rail line; initial boarding is not a change.
        const line = edge.feature.properties.feature_type === 'route' ?
          edge.feature.properties.route_id : current.line;
        const next = stateFor(edge.to, line);
        const candidate = {
          lineChanges: current.lineChanges + (current.line !== null && line !== current.line ? 1 : 0),
          meters: current.meters + edge.meters
        };
        if (!next.visited && better(candidate, next)) {
          next.lineChanges = candidate.lineChanges;
          next.meters = candidate.meters;
          next.previous = current;
          next.edge = edge;
          remaining.add(next);
        }
      }
    }
    if (!destination) throw new Error('No connected path exists between these stations in this dataset.');

    const stationIds = [to];
    const features = [];
    const segmentMeters = [];
    let current = destination;
    while (current !== start) {
      const coordinates = current.edge.feature.geometry.coordinates;
      features.push({
        ...current.edge.feature,
        geometry: { type: 'LineString',
          coordinates: current.edge.reverse ? [...coordinates].reverse() : coordinates }
      });
      segmentMeters.push(current.edge.meters);
      current = current.previous;
      stationIds.push(current.station);
    }
    return {
      stationIds: stationIds.reverse(),
      lineChanges: destination.lineChanges,
      meters: destination.meters,
      segmentMeters: segmentMeters.reverse(),
      geojson: { type: 'FeatureCollection', features: features.reverse() }
    };
  }

  return { buildNetwork, forYear, toGeoJSON, findRoute };
})();

if (typeof module !== 'undefined') module.exports = RailRouting;
