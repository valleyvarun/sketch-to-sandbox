const ConstructionPlan = (() => {
  function phasePath(network, route, from, to) {
    const ids = route.properties.station_ids_in_order;
    const start = ids.indexOf(from);
    const end = ids.indexOf(to);
    if (start < 0 || end < 0 || start === end) {
      throw new Error('Choose two different stations on the same line.');
    }
    const step = start < end ? 1 : -1;
    const stationIds = [from];
    const features = [];
    const openingYears = [];
    const segmentMeters = [];
    let meters = 0;
    for (let i = start; i !== end; i += step) {
      const edge = network.graph.get(ids[i]).find(candidate =>
        candidate.to === ids[i + step] &&
        candidate.feature.properties.route_id === route.properties.route_id);
      if (!edge) throw new Error(`Missing connection on ${route.properties.name}.`);
      features.push({
        ...edge.feature,
        geometry: {
          type: 'LineString',
          coordinates: edge.reverse ?
            [...edge.feature.geometry.coordinates].reverse() : edge.feature.geometry.coordinates
        }
      });
      stationIds.push(ids[i + step]);
      openingYears.push(edge.openingYear);
      segmentMeters.push(edge.meters);
      meters += edge.meters;
    }
    return { stationIds, features, openingYears, segmentMeters, meters };
  }

  function create({ map, data, network, stationValue, activate, refreshVisibility, startPicking, cancelPicking, publish, showEndpoints }) {
    const phases = [];
    const builtPhases = [];
    const routes = data.features.filter(feature => feature.properties.feature_type === 'route');
    const stations = [...network.stations.values()].sort((a, b) =>
      a.properties.name.localeCompare(b.properties.name));
    const list = document.getElementById('phaseList');
    const add = document.getElementById('addPhase');
    const build = document.getElementById('buildPlan');
    const clear = document.getElementById('clearPlan');
    const editor = document.getElementById('constructionEditor');
    const status = document.getElementById('constructionStatus');
    const summary = document.getElementById('builtPlan');
    const calculate = document.getElementById('calculatePlan');
    const clearBuilt = document.getElementById('clearBuiltPlan');
    const buildStatus = document.getElementById('buildStatus');
    const info = ConstructionInfo.create();
    let active = false;
    let focusedLine = null;

    const openedStationColor = '#000000';
    function darker(color) {
      return '#' + color.slice(1).match(/.{2}/g).map(channel =>
        Math.round(parseInt(channel, 16) * 0.5).toString(16).padStart(2, '0')).join('');
    }

    const unopenedStations = stations.filter(station => {
      const year = station.properties.station_opening_year;
      return !Number.isInteger(year) || year > 2026;
    });

    const planningFeatures = [];
    for (const edges of network.graph.values()) {
      for (const edge of edges.filter(candidate => !candidate.reverse)) {
        const constructed = Number.isInteger(edge.openingYear) && edge.openingYear <= 2026;
        planningFeatures.push({
          ...edge.feature,
          properties: {
            ...edge.feature.properties,
            constructed,
            planning_color: constructed ? edge.feature.properties.stroke : darker(edge.feature.properties.stroke)
          }
        });
      }
    }
    for (const station of stations) {
      const color = routes.find(route =>
        route.properties.station_ids_in_order.includes(station.properties.id)).properties.stroke;
      const year = station.properties.station_opening_year;
      const constructed = Number.isInteger(year) && year <= 2026;
      planningFeatures.push({
        ...station, properties: {
          ...station.properties,
          constructed,
          planning_color: constructed ? openedStationColor : color
        }
      });
    }
    const planningData = { type: 'FeatureCollection', features: planningFeatures };
    map.addSource('construction-path', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    for (const system of ['metro', 'suburban']) {
      map.addLayer({
        id: `construction-${system}`, type: 'line', source: 'construction-path',
        filter: ['==', ['get', 'system'], system],
        layout: { 'line-cap': system === 'metro' ? 'round' : 'butt', 'line-join': 'round', visibility: 'none' },
        paint: {
          'line-color': ['get', 'planning_color'],
          'line-width': system === 'metro' ? 6 : 3,
          ...(system === 'suburban' ? { 'line-dasharray': [3, 2] } : {})
        }
      }, 'rail-stations');
    }

    function routeFor(phase) {
      return routes.find(route => route.properties.route_id === phase.line.value);
    }

    function selected(input, choices) {
      const text = input.value.trim().toLowerCase();
      const matches = choices.filter(station =>
        stationValue(station).toLowerCase() === text || station.properties.name.toLowerCase() === text);
      return matches.length === 1 ? matches[0] : null;
    }

    function result(phase) {
      const route = routeFor(phase);
      const from = selected(phase.from, phase.fromChoices);
      const to = selected(phase.to, phase.choices);
      if (!route || !from || !to || from.properties.id === to.properties.id) return null;
      return phasePath(network, route, from.properties.id, to.properties.id);
    }

    function avoidsOverlap(route, from, to) {
      const path = phasePath(network, route, from, to);
      return builtPhases.every(saved => {
        const shared = path.stationIds.filter(id => saved.path.stationIds.includes(id));
        const endpointsOnly = shared.every(id => (id === from || id === to) &&
          (id === saved.path.stationIds[0] || id === saved.path.stationIds.at(-1)));
        // Sharing both ends on the same line also reuses the track between them.
        return endpointsOnly &&
          (saved.route.properties.route_id !== route.properties.route_id || shared.length < 2);
      });
    }

    function validNumbers() {
      const numbers = [...builtPhases.map(phase => phase.number),
        ...phases.map(phase => Number(phase.number.value))];
      return numbers.every(number => Number.isSafeInteger(number) && number > 0) &&
        new Set(numbers).size === numbers.length;
    }

    function allReady() {
      return phases.length > 0 && validNumbers() && phases.every(phase => result(phase));
    }

    function renderMap() {
      if (!active) return;
      showEndpoints(phases.flatMap(phase => [
        selected(phase.from, phase.fromChoices), selected(phase.to, phase.choices)
      ]).filter(Boolean));
      const selectedIds = new Set();
      const highlighted = [];
      const paths = [...builtPhases.map(phase => phase.path), ...phases.map(result)];
      for (const path of paths) {
        if (!path) continue;
        path.stationIds.forEach(id => selectedIds.add(id));
        for (const [i, feature] of path.features.entries()) {
          const constructed = Number.isInteger(path.openingYears[i]) && path.openingYears[i] <= 2026;
          highlighted.push({
            ...feature, properties: {
              ...feature.properties,
              constructed,
              planning_color: feature.properties.stroke
            }
          });
        }
      }
      map.getSource('construction-path').setData({ type: 'FeatureCollection', features: highlighted });
      const onLine = focusedLine ? ['==', ['get', 'route_id'], focusedLine] : true;
      const color = ['get', 'planning_color'];
      for (const [id, width] of [['rail-routes', 3], ['suburban-routes', 1], ['rail-transfers', 1]]) {
        map.setPaintProperty(id, 'line-color', color);
        const lineWidth = ['case', onLine, width, 0.75];
        map.setPaintProperty(id, 'line-width', id === 'rail-transfers' ? lineWidth :
          ['case', ['get', 'constructed'], id === 'rail-routes' ? 6 : 3, lineWidth]);
      }
      for (const system of ['metro', 'suburban']) {
        map.setPaintProperty(`construction-${system}`, 'line-color', color);
      }
      const lineIds = focusedLine ?
        routes.find(route => route.properties.route_id === focusedLine).properties.station_ids_in_order :
        stations.map(station => station.properties.id);
      map.setPaintProperty('rail-stations', 'circle-color', [
        'case', ['get', 'constructed'], openedStationColor,
        ['case', ['in', ['get', 'id'], ['literal', lineIds]], ['get', 'planning_color'], '#000000']
      ]);
      map.setPaintProperty('rail-stations', 'circle-radius', [
        'case', ['in', ['get', 'id'], ['literal', [...selectedIds]]], 6, 4
      ]);
      refreshVisibility();
    }

    function refreshChoices() {
      const interiors = new Set(builtPhases.flatMap(phase => phase.path.stationIds.slice(1, -1)));
      for (const phase of phases) {
        phase.fromChoices.splice(0, phase.fromChoices.length,
          ...unopenedStations.filter(station => !interiors.has(station.properties.id)));
        const from = selected(phase.from, phase.fromChoices);
        const route = routeFor(phase);
        phase.choices.splice(0, phase.choices.length, ...unopenedStations.filter(station =>
          from && route && station.properties.id !== from.properties.id &&
          route.properties.station_ids_in_order.includes(station.properties.id) &&
          avoidsOverlap(route, from.properties.id, station.properties.id)));
        phase.to.disabled = !from || !route;
        phase.pickFrom.disabled = !active;
        phase.pickTo.disabled = !active || phase.to.disabled;
        phase.fromSearch.refresh();
        phase.toSearch.refresh();
      }
    }

    function refresh() {
      cancelPicking();
      refreshChoices();
      const ready = allReady();
      add.hidden = phases.length > 0;
      add.disabled = false;
      build.disabled = !active || !ready;
      clear.disabled = !active || phases.length === 0;
      calculate.disabled = !active || builtPhases.length === 0;
      clearBuilt.disabled = !active || (builtPhases.length === 0 && phases.length === 0);
      phases.forEach(phase => {
        phase.card.disabled = !active;
        phase.legend.textContent = phase.number.value ? `Phase ${phase.number.value}` : 'New phase';
      });
      builtPhases.forEach(phase => { phase.removeButton.disabled = !active; });
      status.textContent = phases.length === 0 ? 'Add a phase to begin.' :
        !validNumbers() ? 'Use a different positive whole phase number for each phase.' :
          ready ? 'Phase ready. Click Add to save it before adding another phase.' :
            'Choose two different stations on one line without overlapping saved phases, except at a shared endpoint.';
      renderMap();
    }

    function updateLine(phase, from) {
      phase.to.value = '';
      phase.toSearch.close();
      phase.line.replaceChildren();
      const choices = from ? routes.filter(route =>
        route.properties.station_ids_in_order.includes(from.properties.id)) : [];
      if (choices.length !== 1) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose a line';
        phase.line.appendChild(placeholder);
      }
      for (const route of choices) {
        const option = document.createElement('option');
        option.value = route.properties.route_id;
        option.textContent = route.properties.name;
        phase.line.appendChild(option);
      }
      phase.line.value = choices.length === 1 ? choices[0].properties.route_id : '';
      phase.lineLabel.hidden = choices.length <= 1;
      phase.line.hidden = choices.length <= 1;
    }

    function synchronize(phase, firstChanged) {
      if (firstChanged) updateLine(phase, selected(phase.from, phase.fromChoices));
      const route = routeFor(phase);
      focusedLine = route?.properties.route_id || null;
      refresh();
    }

    function field(card, labelText, id, type = 'text', container = card) {
      const label = document.createElement('label');
      label.setAttribute('for', id);
      label.textContent = labelText;
      const input = document.createElement('input');
      input.id = id;
      input.type = type;
      card.appendChild(label);
      container.appendChild(input);
      return input;
    }

    function stationField(card, labelText, id) {
      const row = document.createElement('div');
      row.className = 'station-input-row';
      const input = field(card, labelText, id, 'text', row);
      const button = document.createElement('button');
      button.id = `${id}-pick`;
      button.type = 'button';
      button.className = 'pick-button';
      button.textContent = '\u2295';
      button.setAttribute('title', `Pick ${labelText.toLowerCase()} from map`);
      button.setAttribute('aria-label', `Pick ${labelText.toLowerCase()} from map`);
      button.setAttribute('aria-pressed', 'false');
      row.appendChild(button);
      card.appendChild(row);
      return { input, button };
    }

    function searchList(card, input) {
      const suggestions = document.createElement('div');
      suggestions.id = `${input.id}-suggestions`;
      suggestions.className = 'station-suggestions';
      suggestions.hidden = true;
      suggestions.setAttribute('role', 'listbox');
      suggestions.setAttribute('aria-label', input.id.endsWith('-from') ? 'Phase start stations' : 'Phase end stations');
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('aria-controls', suggestions.id);
      input.autocomplete = 'off';
      input.placeholder = 'Search stations';
      card.appendChild(suggestions);
      return suggestions;
    }

    add.addEventListener('click', () => {
      activate();
      if (phases.length) return;
      const id = builtPhases.length + 1;
      const card = document.createElement('fieldset');
      card.className = 'phase-card';
      const legend = document.createElement('legend');
      legend.textContent = 'New phase';
      card.appendChild(legend);
      const number = field(card, 'Phase Number', `phase-${id}-number`, 'number');
      number.min = '1';
      number.step = '1';
      number.value = String(builtPhases.length ? Math.max(...builtPhases.map(phase => phase.number)) + 1 : 3);
      const { input: from, button: pickFrom } = stationField(card, 'First station', `phase-${id}-from`);
      const fromList = searchList(card, from);
      const lineLabel = document.createElement('label');
      lineLabel.setAttribute('for', `phase-${id}-line`);
      lineLabel.textContent = 'Line';
      lineLabel.hidden = true;
      const line = document.createElement('select');
      line.id = `phase-${id}-line`;
      line.hidden = true;
      card.appendChild(lineLabel);
      card.appendChild(line);
      const { input: to, button: pickTo } = stationField(card, 'Second station', `phase-${id}-to`);
      to.disabled = true;
      const toList = searchList(card, to);
      const phase = { card, legend, number, from, to, pickFrom, pickTo, line, lineLabel, fromChoices: [], choices: [] };
      phase.fromSearch = createStationSearch(from, fromList, phase.fromChoices, stationValue, () => synchronize(phase, true));
      phase.toSearch = createStationSearch(to, toList, phase.choices, stationValue, () => synchronize(phase, false));
      for (const [button, input, choices] of [[pickFrom, from, phase.fromChoices], [pickTo, to, phase.choices]]) {
        button.addEventListener('click', () => {
          if (!active || button.disabled) return;
          closeSearches();
          focusedLine = routeFor(phase)?.properties.route_id || null;
          renderMap();
          startPicking({
            input, button, status, choices,
            onSelect: () => synchronize(phase, input === from)
          });
        });
      }
      number.addEventListener('input', () => refresh());
      line.addEventListener('change', () => {
        to.value = '';
        phase.toSearch.close();
        synchronize(phase, false);
      });
      card.addEventListener('focusin', () => {
        focusedLine = routeFor(phase)?.properties.route_id || null;
        renderMap();
      });
      phases.push(phase);
      list.appendChild(card);
      focusedLine = null;
      refresh();
      from.focus();
    });

    function clearDraft() {
      cancelPicking();
      phases.forEach(phase => {
        phase.fromSearch.destroy();
        phase.toSearch.destroy();
      });
      phases.length = 0;
      list.replaceChildren();
      focusedLine = null;
    }

    clear.addEventListener('click', () => {
      if (!active || phases.length === 0) return;
      closeSearches();
      phases.forEach(phase => {
        phase.from.value = '';
        updateLine(phase, null);
      });
      focusedLine = null;
      refresh();
      status.textContent = 'Phase selections cleared. Saved phases are unchanged.';
    });

    function updateSummaryCount() {
      summary.children[0].textContent = builtPhases.length ?
        `${builtPhases.length} phase${builtPhases.length === 1 ? '' : 's'} added.` :
        'No phases added yet.';
    }

    function invalidate(reset = false) {
      info.clear();
      publish(null, reset);
      buildStatus.textContent = builtPhases.length ? 'Click Build to calculate and apply the saved phases.' : '';
    }

    calculate.addEventListener('click', () => {
      if (!active || !builtPhases.length) return;
      cancelPicking();
      try {
        const report = ConstructionInfo.calculate(builtPhases, network);
        publish(report);
        info.show(report);
        buildStatus.textContent = 'Built simulation. Switch to Travel to explore the projected years.';
      } catch (error) {
        console.error('Construction estimate error:', error);
        invalidate();
        buildStatus.textContent = error.message;
      }
    });

    clearBuilt.addEventListener('click', () => {
      if (!active) return;
      clearDraft();
      builtPhases.forEach(phase => { phase.removeButton.disabled = true; });
      builtPhases.length = 0;
      summary.replaceChildren();
      summary.appendChild(document.createElement('p'));
      updateSummaryCount();
      invalidate(true);
      refresh();
      buildStatus.textContent = 'Plan cleared. Default map years restored.';
    });

    build.addEventListener('click', () => {
      if (!active || !allReady()) {
        status.textContent = 'Complete every phase with unique phase numbers and two stations on one line. Saved phases may overlap only at a shared endpoint.';
        return;
      }
      const phase = phases[0];
      const removeButton = document.createElement('button');
      const saved = { number: Number(phase.number.value), route: routeFor(phase), path: result(phase), removeButton };
      builtPhases.push(saved);
      if (builtPhases.length === 1) {
        summary.replaceChildren();
        summary.appendChild(document.createElement('p'));
      }
      updateSummaryCount();
      const path = saved.path;
      const section = document.createElement('section');
      section.className = 'built-phase';
      const title = document.createElement('h3');
      title.textContent = `Phase ${saved.number}`;
      section.appendChild(title);
      const description = document.createElement('p');
      description.textContent = `${saved.route.properties.name} | ${(path.meters / 1000).toFixed(1)} km | ${path.stationIds.length} stations`;
      section.appendChild(description);
      const stationNames = document.createElement('ol');
      for (const id of path.stationIds) {
        const item = document.createElement('li');
        item.textContent = stationValue(network.stations.get(id));
        stationNames.appendChild(item);
      }
      section.appendChild(stationNames);
      removeButton.type = 'button';
      removeButton.className = 'clear-phase';
      removeButton.textContent = 'Clear';
      removeButton.setAttribute('aria-label', `Delete Phase ${saved.number}`);
      removeButton.setAttribute('title', `Delete Phase ${saved.number}`);
      removeButton.addEventListener('click', () => {
        if (!active || removeButton.disabled) return;
        removeButton.disabled = true;
        builtPhases.splice(builtPhases.indexOf(saved), 1);
        summary.removeChild(section);
        updateSummaryCount();
        invalidate();
        focusedLine = null;
        refresh();
        status.textContent = `Phase ${saved.number} deleted. Other phases and the current draft are unchanged.`;
      });
      section.appendChild(removeButton);
      summary.appendChild(section);
      invalidate();
      clearDraft();
      refresh();
      status.textContent = `Phase ${saved.number} saved. Add another phase or review the plan on the right.`;
    });

    function closeSearches() {
      phases.forEach(phase => { phase.fromSearch.close(); phase.toSearch.close(); });
    }

    function setActive(value) {
      active = value;
      closeSearches();
      editor.setAttribute('aria-disabled', String(!active));
      if (active) map.getSource('rail-network').setData(planningData);
      refresh();
    }

    refresh();
    return { setActive, renderMap, phases };
  }

  return { create, phasePath };
})();

if (typeof module !== 'undefined') module.exports = ConstructionPlan;
