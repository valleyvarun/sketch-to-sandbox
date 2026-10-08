// ==========================================================================
// Mapbox Initialization - Namma Metro Bengaluru
// Replace with your Mapbox Public Access Token
// ==========================================================================
const DEFAULT_TOKEN = 'YOUR_MAPBOX_ACCESS_TOKEN';

function initMap(token) {
  mapboxgl.accessToken = token;
  const status = document.getElementById('travelStatus');
  const travelInfo = TravelInfo.create();
  const travelPanel = document.getElementById('travelPanel');
  const builtPlan = document.getElementById('builtPlan');
  travelPanel.hidden = false;
  builtPlan.hidden = true;
  status.textContent = 'Loading map and station network...';

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [77.5946, 12.9716], // Bengaluru coordinates [lng, lat]
    zoom: 11
  });

  map.addControl(new mapboxgl.NavigationControl(), 'top-right');

  async function loadNetwork() {
    const response = await fetch('./datasets/Bengaluru_metro_suburban_rail_upgraded.geojson');
    if (!response.ok) throw new Error(`Could not load station data (HTTP ${response.status}).`);
    const data = await response.json();
    const network = RailRouting.buildNetwork(data);
    let visibleNetwork = network;
    const years = [...Array.from({ length: 17 }, (_, i) => 2010 + i), null];
    let yearIndex = years.length - 1;
    // Use our station labels rather than a second, uncontrolled set from the basemap.
    map.getStyle().layers.filter(layer =>
      layer.type === 'symbol' && layer['source-layer'] === 'transit_stop'
    ).forEach(layer => map.setLayoutProperty(layer.id, 'visibility', 'none'));
    const emptyPath = { type: 'FeatureCollection', features: [] };
    let activeRoute = null;
    let picking = null;
    let endpointMarkers = [];
    let stationInfo = null;
    let construction = null;
    let constructionActive = false;
    let travelYearIndex = yearIndex;
    let travelVisibility = null;

    function closeStationInfo() {
      if (stationInfo) stationInfo.popup.remove();
      stationInfo = null;
    }

    function showStationInfo(station) {
      closeStationInfo();
      const properties = station.properties;
      const [longitude, latitude] = station.geometry.coordinates;
      const content = document.createElement('div');
      const table = document.createElement('table');
      const caption = document.createElement('caption');
      caption.textContent = 'Station information';
      table.appendChild(caption);
      const rows = [
        ['Name', properties.name],
        ['Coordinates (lat, lon)', `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`],
        ['Opening date', properties.station_opening_date ?? '-'],
        ['Opening year', properties.station_opening_year ?? '-']
      ];
      for (const [label, value] of rows) {
        const row = document.createElement('tr');
        const heading = document.createElement('th');
        heading.setAttribute('scope', 'row');
        heading.textContent = label;
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.appendChild(heading);
        row.appendChild(cell);
        table.appendChild(row);
      }
      content.appendChild(table);
      const note = document.createElement('p');
      note.textContent = 'Dates refer to the earliest recorded passenger-service opening, not construction completion.';
      if (properties.opening_date_conflict) {
        note.textContent += ' The source reports conflicting opening dates.';
      }
      content.appendChild(note);
      const popup = new mapboxgl.Popup({ className: 'station-popup', maxWidth: '320px', offset: 12 })
        .setLngLat(station.geometry.coordinates)
        .setDOMContent(content)
        .addTo(map);
      stationInfo = { popup, station };
    }

    map.addSource('rail-network', {
      type: 'geojson',
      data
    });
    map.addSource('travel-path', { type: 'geojson', data: emptyPath });

    const routeLayers = [{
      id: 'rail-routes',
      type: 'line',
      source: 'rail-network',
      filter: ['all',
        ['==', ['geometry-type'], 'LineString'],
        ['==', ['get', 'system'], 'metro']
      ],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'stroke'], 'line-width': 3 }
    }, {
      id: 'suburban-routes',
      type: 'line',
      source: 'rail-network',
      filter: ['all',
        ['==', ['geometry-type'], 'LineString'],
        ['==', ['get', 'system'], 'suburban']
      ],
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: {
        'line-color': ['get', 'stroke'],
        'line-width': 1,
        'line-dasharray': [9, 6]
      }
    }, {
      id: 'rail-transfers',
      type: 'line',
      source: 'rail-network',
      filter: ['all',
        ['==', ['geometry-type'], 'LineString'],
        ['!', ['has', 'system']]
      ],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'stroke'], 'line-width': 3 }
    }];
    routeLayers.forEach(layer => map.addLayer(layer));
    routeLayers.forEach(layer => map.addLayer({
      ...layer, id: `travel-${layer.id}`, source: 'travel-path'
    }));

    map.addLayer({
      id: 'rail-stations',
      type: 'circle',
      source: 'rail-network',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 4,
        'circle-color': '#0b1c36',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5
      }
    });

    map.addLayer({
      id: 'station-names',
      type: 'symbol',
      source: 'rail-network',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
        'text-size': 11,
        'text-anchor': 'left',
        'text-offset': [0.7, 0]
      },
      paint: {
        'text-color': '#000000',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1
      }
    });

    const metro = document.getElementById('showMetro');
    const suburban = document.getElementById('showSuburban');
    const stationNames = document.getElementById('showStationNames');
    const fromInput = document.getElementById('fromStation');
    const toInput = document.getElementById('toStation');
    const pickFrom = document.getElementById('pickFrom');
    const pickTo = document.getElementById('pickTo');
    const run = document.getElementById('runTravel');
    const clear = document.getElementById('clearTravel');
    const allStations = [...network.stations.values()].sort((a, b) =>
      a.properties.name.localeCompare(b.properties.name));
    const stationList = [...allStations];
    const nameCounts = new Map();
    stationList.forEach(station => {
      const name = station.properties.name.trim().toLowerCase();
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    });
    const stationValue = station => {
      const { name, id } = station.properties;
      return nameCounts.get(name.trim().toLowerCase()) > 1 ? `${name} [${id}]` : name;
    };

    [fromInput, toInput, pickFrom, pickTo, clear].forEach(control => { control.disabled = false; });

    function selectedStation(input) {
      const value = input.value.trim().toLowerCase();
      const matches = stationList.filter(station =>
        stationValue(station).toLowerCase() === value ||
        station.properties.name.toLowerCase() === value);
      return matches.length === 1 ? matches[0] : null;
    }

    function updateRun() {
      const from = selectedStation(fromInput);
      const to = selectedStation(toInput);
      run.disabled = constructionActive || !from || !to || from.properties.id === to.properties.id;
    }

    function updateVisibility() {
      const systems = [];
      if (metro.checked) systems.push('metro');
      if (suburban.checked) systems.push('suburban');

      map.setLayoutProperty('rail-routes', 'visibility', metro.checked ? 'visible' : 'none');
      map.setLayoutProperty('suburban-routes', 'visibility', suburban.checked ? 'visible' : 'none');
      map.setLayoutProperty('rail-transfers', 'visibility',
        metro.checked && suburban.checked ? 'visible' : 'none');
      map.setLayoutProperty('station-names', 'visibility', stationNames.checked ? 'visible' : 'none');
      map.setLayoutProperty('station-names', 'text-allow-overlap', Boolean(activeRoute));
      for (const layer of routeLayers) {
        map.setLayoutProperty(`travel-${layer.id}`, 'visibility',
          map.getLayoutProperty(layer.id, 'visibility'));
      }
      if (construction) {
        map.setLayoutProperty('construction-metro', 'visibility',
          constructionActive && metro.checked ? 'visible' : 'none');
        map.setLayoutProperty('construction-suburban', 'visibility',
          constructionActive && suburban.checked ? 'visible' : 'none');
      }

      const stationFilter = ['all',
        ['==', ['geometry-type'], 'Point'],
        ['in', ['get', 'system'], ['literal', systems]]
      ];
      map.setFilter('rail-stations', stationFilter);
      map.setFilter('station-names', activeRoute ? ['all', stationFilter,
        ['in', ['get', 'id'], ['literal', activeRoute.stationIds]]
      ] : stationFilter);
      endpointMarkers.forEach(({ marker, station }) => {
        marker.getElement().hidden = !systems.includes(station.properties.system);
      });
      if (stationInfo && !systems.includes(stationInfo.station.properties.system)) closeStationInfo();
    }

    function clearRoute() {
      activeRoute = null;
      travelInfo.clear();
      map.getSource('travel-path').setData(emptyPath);
      endpointMarkers.forEach(({ marker }) => marker.remove());
      endpointMarkers = [];
      routeLayers.forEach(layer => {
        map.setPaintProperty(layer.id, 'line-color', layer.paint['line-color']);
        map.setPaintProperty(layer.id, 'line-width', layer.paint['line-width']);
      });
      updateVisibility();
    }

    function setPicking(target) {
      if (picking) picking.button.setAttribute('aria-pressed', 'false');
      picking = target;
      pickFrom.setAttribute('aria-pressed', String(target?.input === fromInput));
      pickTo.setAttribute('aria-pressed', String(target?.input === toInput));
      if (target) {
        closeStationInfo();
        target.button.setAttribute('aria-pressed', 'true');
      }
      map.getCanvas().style.cursor = target ? 'crosshair' : '';
    }

    function startPicking(target) {
      if (target.button.disabled) return;
      setPicking(picking?.button === target.button ? null : target);
      target.status.textContent = picking ?
        'Click an available station dot on the map. Press Escape to cancel.' :
        'Map picking cancelled.';
    }

    clear.addEventListener('click', () => {
      searches.forEach(search => search.close());
      fromInput.value = '';
      toInput.value = '';
      setPicking(null);
      clearRoute();
      updateRun();
      status.textContent = 'Travel cleared. Choose two stations to plan another route.';
    });

    const searches = [
      [fromInput, document.getElementById('fromSuggestions')],
      [toInput, document.getElementById('toSuggestions')]
    ].map(([input, list]) =>
      createStationSearch(input, list, stationList, stationValue, () => {
        setPicking(null);
        clearRoute();
        updateRun();
        const ambiguous = [fromInput, toInput].some(field =>
          nameCounts.get(field.value.trim().toLowerCase()) > 1);
        status.textContent = ambiguous ?
          'Several stations share that name. Choose a suggestion with a station ID.' :
          run.disabled ? 'Choose two different stations from the suggestions or map.' : 'Ready to run.';
      })
    );

    const previousYear = document.getElementById('previousYear');
    const nextYear = document.getElementById('nextYear');
    const mapYear = document.getElementById('mapYear');
    const autoplay = document.getElementById('autoplayYears');
    let autoplayTimer = null;

    function stopAutoplay() {
      clearInterval(autoplayTimer);
      autoplayTimer = null;
      autoplay.setAttribute('aria-pressed', 'false');
      autoplay.setAttribute('aria-label', 'Play years');
      autoplay.setAttribute('title', 'Play years');
      autoplay.children[0].textContent = '\u25B6';
    }

    function changeYear(index) {
      if (constructionActive) return;
      if (index < 0 || index >= years.length) return;
      yearIndex = index;
      const year = years[yearIndex];
      visibleNetwork = RailRouting.forYear(network, year);
      searches.forEach(search => search.close());
      setPicking(null);
      closeStationInfo();
      clearRoute();
      stationList.splice(0, stationList.length,
        ...allStations.filter(station => visibleNetwork.stations.has(station.properties.id)));
      [fromInput, toInput].forEach(input => {
        if (!selectedStation(input)) input.value = '';
      });
      updateRun();
      map.getSource('rail-network').setData(year === null ? data : RailRouting.toGeoJSON(visibleNetwork));
      mapYear.textContent = year === null ? 'final plan' : String(year);
      mapYear.setAttribute('data-final-plan', String(year === null));
      previousYear.disabled = yearIndex === 0;
      nextYear.disabled = yearIndex === years.length - 1;
      status.textContent = year === null ? 'Final plan: all routes, including proposals.' :
        visibleNetwork.stations.size ?
          `Recorded openings through ${year}. Routes use only this year's network.` :
          `No stations are recorded as open by ${year}.`;
    }
    previousYear.addEventListener('click', () => {
      stopAutoplay();
      changeYear(yearIndex - 1);
    });
    nextYear.addEventListener('click', () => {
      stopAutoplay();
      changeYear(yearIndex + 1);
    });
    autoplay.addEventListener('click', () => {
      if (constructionActive) return;
      if (autoplayTimer !== null) {
        stopAutoplay();
        return;
      }
      changeYear(0);
      autoplay.setAttribute('aria-pressed', 'true');
      autoplay.setAttribute('aria-label', 'Pause years');
      autoplay.setAttribute('title', 'Pause years');
      autoplay.children[0].textContent = '\u23F8';
      autoplayTimer = setInterval(() => changeYear((yearIndex + 1) % years.length), 1000);
    });
    map.on('remove', stopAutoplay);
    autoplay.disabled = false;
    previousYear.disabled = false;
    nextYear.disabled = true;
    mapYear.textContent = 'final plan';
    mapYear.setAttribute('data-final-plan', 'true');

    const travelMode = document.getElementById('travelMode');
    const constructionMode = document.getElementById('constructionMode');
    const travelForm = document.getElementById('travelForm');

    function setMode(useConstruction) {
      if (constructionActive === useConstruction) return;
      stopAutoplay();
      searches.forEach(search => search.close());
      setPicking(null);
      closeStationInfo();
      fromInput.value = '';
      toInput.value = '';
      clearRoute();
      if (useConstruction) {
        travelYearIndex = yearIndex;
        travelVisibility = [metro.checked, suburban.checked, stationNames.checked];
        changeYear(years.length - 1);
        metro.checked = true;
        suburban.checked = true;
      }
      constructionActive = useConstruction;
      travelPanel.hidden = useConstruction;
      builtPlan.hidden = !useConstruction;
      construction.setActive(useConstruction);
      if (!useConstruction) {
        [metro.checked, suburban.checked, stationNames.checked] = travelVisibility;
        map.setPaintProperty('rail-stations', 'circle-radius', 4);
        map.setPaintProperty('rail-stations', 'circle-color', '#0b1c36');
        changeYear(travelYearIndex);
      }
      [fromInput, toInput, pickFrom, pickTo, clear].forEach(control => {
        control.disabled = useConstruction;
      });
      travelForm.setAttribute('aria-disabled', String(useConstruction));
      travelMode.setAttribute('aria-pressed', String(!useConstruction));
      constructionMode.setAttribute('aria-pressed', String(useConstruction));
      previousYear.disabled = useConstruction || yearIndex === 0;
      nextYear.disabled = useConstruction || yearIndex === years.length - 1;
      autoplay.disabled = useConstruction;
      updateRun();
      updateVisibility();
    }

    construction = ConstructionPlan.create({
      map, data, network, stationValue,
      activate: () => setMode(true),
      refreshVisibility: updateVisibility,
      startPicking,
      cancelPicking: () => setPicking(null)
    });
    travelMode.disabled = false;
    constructionMode.disabled = false;
    travelMode.addEventListener('click', () => setMode(false));
    constructionMode.addEventListener('click', () => setMode(true));

    [[pickFrom, fromInput], [pickTo, toInput]].forEach(([button, input]) => {
      button.addEventListener('click', () => {
        searches.forEach(search => search.close());
        startPicking({
          input, button, status, choices: stationList,
          onSelect() {
            clearRoute();
            updateRun();
            status.textContent = run.disabled ? 'Choose a different station for the other field.' : 'Ready to run.';
          }
        });
      });
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && picking) {
        const pickingStatus = picking.status;
        setPicking(null);
        pickingStatus.textContent = 'Map picking cancelled.';
      }
    });
    map.on('click', event => {
      const { x, y } = event.point;
      const features = map.queryRenderedFeatures([[x - 8, y - 8], [x + 8, y + 8]], {
        layers: ['rail-stations']
      }).filter(feature => visibleNetwork.stations.has(feature.properties.id));
      const nearest = features.sort((a, b) => {
        const p = map.project(a.geometry.coordinates);
        const q = map.project(b.geometry.coordinates);
        return Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y);
      })[0];
      if (!nearest) {
        closeStationInfo();
        if (picking) picking.status.textContent = 'No station there. Click a station dot on a visible network.';
        return;
      }
      const station = network.stations.get(nearest.properties.id);
      if (!picking) {
        showStationInfo(station);
        return;
      }
      if (!picking.choices.some(choice => choice.properties.id === station.properties.id)) {
        picking.status.textContent = 'That station is not available for this field. Choose a station offered in its dropdown.';
        return;
      }
      const target = picking;
      target.input.value = stationValue(station);
      setPicking(null);
      target.onSelect();
    });

    document.getElementById('travelForm').addEventListener('submit', event => {
      event.preventDefault();
      if (constructionActive) return;
      searches.forEach(search => search.close());
      setPicking(null);
      clearRoute();
      const from = selectedStation(fromInput);
      const to = selectedStation(toInput);
      try {
        activeRoute = RailRouting.findRoute(visibleNetwork, from?.properties.id, to?.properties.id);
        travelInfo.show(activeRoute, stationValue(from), stationValue(to),
          id => stationValue(network.stations.get(id)));
      } catch (error) {
        console.error('Travel route error:', error);
        clearRoute();
        status.textContent = error.message;
        updateRun();
        return;
      }

      // Reveal the networks used by the result, even if they were previously hidden.
      for (const id of activeRoute.stationIds) {
        const system = network.stations.get(id).properties.system;
        if (system === 'metro') metro.checked = true;
        if (system === 'suburban') suburban.checked = true;
      }
      stationNames.checked = true;
      map.getSource('travel-path').setData(activeRoute.geojson);
      routeLayers.forEach(layer => {
        map.setPaintProperty(layer.id, 'line-color', '#000000');
        map.setPaintProperty(layer.id, 'line-width', 0.75);
      });
      [[from, 'Start'], [to, 'End']].forEach(([station, label]) => {
        const element = document.createElement('div');
        element.className = 'endpoint-marker';
        element.setAttribute('aria-label', `${label}: ${station.properties.name}`);
        const caption = document.createElement('span');
        caption.textContent = label;
        element.appendChild(caption);
        const marker = new mapboxgl.Marker({ element })
          .setLngLat(station.geometry.coordinates).addTo(map);
        endpointMarkers.push({ marker, station });
      });
      updateVisibility();
      const bounds = new mapboxgl.LngLatBounds();
      activeRoute.geojson.features.forEach(feature =>
        feature.geometry.coordinates.forEach(point => bounds.extend(point)));
      map.fitBounds(bounds, { padding: 45, maxZoom: 14, duration: 700 });
      status.textContent = '';
    });

    updateRun();
    status.textContent = 'Choose two stations. Planning routes include proposed lines.';

    [metro, suburban, stationNames].forEach(checkbox => {
      checkbox.addEventListener('change', updateVisibility);
    });
    updateVisibility();
  }

  map.on('load', () => {
    loadNetwork().catch(error => {
      console.error('Rail network loading error:', error);
      status.textContent = `Could not prepare travel routing: ${error.message} Reload the page to retry.`;
    });
  });

  map.on('error', (e) => {
    console.error('Mapbox error:', e);
    status.textContent = 'Map data could not load. Check your connection and Mapbox token, then reload.';
  });

  return map;
}

document.addEventListener('DOMContentLoaded', () => {
  let map;
  setupSidebarResize(() => map?.resize());
  const mapContainer = document.getElementById('map');
  const savedToken = localStorage.getItem('mapbox_token') || DEFAULT_TOKEN;

  if (savedToken && savedToken !== 'YOUR_MAPBOX_ACCESS_TOKEN') {
    map = initMap(savedToken);
  } else {
    // Show minimal placeholder prompt to enter Mapbox token
    const promptBox = document.createElement('div');
    promptBox.className = 'token-prompt';
    promptBox.innerHTML = `
      <div class="token-prompt-content">
        <p class="prompt-title">Mapbox Access Token Required</p>
        <p class="prompt-subtitle">Enter your Mapbox public token or configure it in <code>script.js</code>.</p>
        <div class="prompt-input-group">
          <input type="text" id="tokenInput" placeholder="pk.eyJ..." />
          <button id="saveTokenBtn">Load Map</button>
        </div>
      </div>
    `;
    mapContainer.appendChild(promptBox);

    document.getElementById('saveTokenBtn').addEventListener('click', () => {
      const input = document.getElementById('tokenInput').value.trim();
      if (input) {
        localStorage.setItem('mapbox_token', input);
        promptBox.remove();
        map = initMap(input);
      }
    });
  }
});
