/* global MAP_DATA, L */

const map = L.map('map', { preferCanvas: true }).setView([49.5, 17.5], 5.5);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
}).addTo(map);

const state = {
  currentCountryId: null,
  countryLayers: {},
  operatorVisibility: {},
  heatmapVisibility: {},
  catchmentMode: 'geographic',
  nearestFilterEnabled: false,
  filterView: 'catchment', // 'none' | 'catchment' | 'nearest'
};

const countrySelect = document.getElementById('countrySelect');
const operatorContainer = document.getElementById('operatorContainer');
const heatmapToggle = document.getElementById('heatmapToggle');
// filter view radios (none / catchment / nearest)
const filterViewInputs = Array.from(document.querySelectorAll('input[name="filterView"]'));
// Explicit list of brands to include in the nearest-store search (country-by-country)
const TELEKOM_BRANDS = [
  'Magenta',
  'Cosmote / Germanos',
  'Magyar Telekom',
  'Makedonski Telekom',
  'Slovak Telekom',
  'T-Mobile CZ',
  'T-Mobile',
  'T-Mobile HR',
];

function isTelekomBrandName(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  return TELEKOM_BRANDS.some(b => String(b).toLowerCase() === n);
}
const catchmentModeInputs = Array.from(document.querySelectorAll('input[name="catchmentMode"]'));
const countryOrder = MAP_DATA.order || Object.keys(MAP_DATA.countries || {});

function addLayer(mapInstance, layer) {
  if (layer && !mapInstance.hasLayer(layer)) {
    mapInstance.addLayer(layer);
  }
}

function removeLayer(mapInstance, layer) {
  if (layer && mapInstance.hasLayer(layer)) {
    mapInstance.removeLayer(layer);
  }
}

function setLayerVisible(layer, visible) {
  if (visible) {
    addLayer(map, layer);
  } else {
    removeLayer(map, layer);
  }
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

function getPopulationPoints(country) {
  return country.heatmap || [];
}

function estimatePopulationNearStore(store, populationPoints, baseRadiusKm) {
  let total = 0;
  populationPoints.forEach((point) => {
    const distanceKm = haversineKm(store.lat, store.lng, point[0], point[1]);
    if (distanceKm <= baseRadiusKm) {
      total += Number(point[2] || 0);
    }
  });
  return total;
}

function estimateSharedPopulationNearStore(store, stores, populationPoints, baseRadiusKm) {
  let rawPopulation = 0;
  let allocatedPopulation = 0;
  let sharedPopulation = 0;

  populationPoints.forEach((point) => {
    const pointPopulation = Number(point[2] || 0);
    if (!pointPopulation) return;

    const distanceToCurrentStore = haversineKm(store.lat, store.lng, point[0], point[1]);
    if (distanceToCurrentStore > baseRadiusKm) return;

    rawPopulation += pointPopulation;

    const coveringStores = stores.filter(({ store: candidateStore }) => {
      const distanceKm = haversineKm(candidateStore.lat, candidateStore.lng, point[0], point[1]);
      return distanceKm <= baseRadiusKm;
    });

    if (!coveringStores.length) return;

    const share = pointPopulation / coveringStores.length;
    allocatedPopulation += share;
    if (coveringStores.length > 1) {
      sharedPopulation += pointPopulation;
    }
  });

  return {
    rawPopulationNearby: rawPopulation,
    allocatedPopulationNearby: allocatedPopulation,
    populationNearby: (rawPopulation + allocatedPopulation) / 2,
    sharedPopulation,
  };
}

function computeDemographicRadius(populationNearby, minPopulation, maxPopulation, baseRadiusKm) {
  const minRadiusMeters = baseRadiusKm * 1000 * 0.7;
  const maxRadiusMeters = baseRadiusKm * 1000 * 2.6;

  if (!Number.isFinite(populationNearby) || populationNearby <= 0) {
    return minRadiusMeters;
  }

  const lower = Math.max(minPopulation || 0, 1);
  const upper = Math.max(maxPopulation || lower, lower + 1);
  const normalized = Math.max(0, Math.min(1, (populationNearby - lower) / (upper - lower)));
  return minRadiusMeters + (maxRadiusMeters - minRadiusMeters) * normalized;
}

function hasCompetitorsNearby(storeLocation, operatorId, radiusKm) {
  const radiusMeters = radiusKm * 1000;
  for (let countryId in MAP_DATA.countries) {
    const country = MAP_DATA.countries[countryId];
    for (let op of country.operators) {
      if (op.id === operatorId) continue;
      if (!op.points) continue;
      for (let point of op.points) {
        const distanceKm = haversineKm(storeLocation.lat, storeLocation.lng, point.lat, point.lng);
        if (distanceKm * 1000 < radiusMeters) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasStoresNearby(storeLocation, radiusKm = 2) {
  const radiusMeters = radiusKm * 1000;
  for (let countryId in MAP_DATA.countries) {
    const country = MAP_DATA.countries[countryId];
    for (let op of country.operators) {
      if (!op.points) continue;
      for (let point of op.points) {
        if (point.lat === storeLocation.lat && point.lng === storeLocation.lng) continue;
        const distanceKm = haversineKm(storeLocation.lat, storeLocation.lng, point.lat, point.lng);
        if (distanceKm * 1000 < radiusMeters) {
          return true;
        }
      }
    }
  }
  return false;
}

function buildCatchmentLayers(countryId) {
  const country = MAP_DATA.countries[countryId];
  if (!country) return null;
  const layers = buildCountryLayers(countryId);
  if (!layers) return null;

  if (layers.catchmentCircleLayers) {
    return layers.catchmentCircleLayers;
  }

  const currentVisibility = state.operatorVisibility[countryId] || {};
  const dtOperator = (country.operators || []).find((operator) => operator.id === country.dtBrand);
  const dtVisible = !dtOperator || currentVisibility[dtOperator.id] !== false;

  const populationPoints = getPopulationPoints(country);
  const baseRadiusKm = MAP_DATA.config?.catchmentRadiusKm || 15;
  const stores = (country.operators || [])
    .filter((operator) => operator.id === country.dtBrand)
    .flatMap((operator) => (operator.points || []).map((store) => ({ operator, store })));

  const allStores = (country.operators || [])
    .flatMap((operator) => (operator.points || []).map((store) => ({ operator, store })));

  const caughtPopulationStats = stores.map(({ store }) => estimateSharedPopulationNearStore(store, allStores, populationPoints, baseRadiusKm));
  const caughtPopulations = caughtPopulationStats.map((item) => item.populationNearby);
  const minPopulation = Math.min(...caughtPopulations, 0);
  const maxPopulation = Math.max(...caughtPopulations, 1);

  const geographicLayer = L.layerGroup();
  const demographicLayer = L.layerGroup();

  stores.forEach(({ operator, store }, index) => {
    const populationNearby = caughtPopulations[index] || 0;
    const rawPopulationNearby = caughtPopulationStats[index]?.rawPopulationNearby || 0;
    const allocatedPopulationNearby = caughtPopulationStats[index]?.allocatedPopulationNearby || 0;
    const sharedPopulationNearby = caughtPopulationStats[index]?.sharedPopulation || 0;
    const geographicCircle = L.circle([store.lat, store.lng], {
      radius: baseRadiusKm * 1000,
      color: '#1f4d7a',
      weight: 1.5,
      opacity: 0.85,
      fillColor: '#57a6ff',
      fillOpacity: 0.10,
      dashArray: '5,6',
    });

    geographicCircle.bindPopup(`
      <div style="min-width:220px">
        <strong>${operator.id}</strong><br>
        Mode: Geographic catchment radius<br>
        Radius: ${baseRadiusKm} km
      </div>
    `, { maxWidth: 320 });
    geographicCircle.addTo(geographicLayer);

    const demographicRadiusMeters = computeDemographicRadius(populationNearby, minPopulation, maxPopulation, baseRadiusKm);

    const hasCompetitors = hasCompetitorsNearby(store, operator.id, baseRadiusKm);
    const hasOverlap = hasStoresNearby(store, 2);
    const populationThresholdLow = minPopulation + (maxPopulation - minPopulation) * 0.25;
    const populationThresholdHigh = minPopulation + (maxPopulation - minPopulation) * 0.75;
    const overlapRatio = rawPopulationNearby > 0 ? sharedPopulationNearby / rawPopulationNearby : 0;
    
    let demographicColor = '#999999';
    let viabilityRating = 'Medium - Stable';
    
    if (!hasCompetitors) {
      demographicColor = '#1a9850';
      viabilityRating = 'Local monopoly - Strong position';
    } else if (rawPopulationNearby < populationThresholdLow && hasOverlap) {
      demographicColor = '#d73027';
      viabilityRating = 'Critical - Low pop + cannibalisation';
    } else if (rawPopulationNearby < populationThresholdLow && hasCompetitors) {
      demographicColor = '#fc8d59';
      viabilityRating = 'Competitive market - Low pop';
    } else if (rawPopulationNearby > populationThresholdHigh && overlapRatio < 0.6) {
      demographicColor = '#1a9850';
      viabilityRating = 'High - Strong market';
    } else if (rawPopulationNearby > populationThresholdHigh && overlapRatio >= 0.6) {
      demographicColor = '#2b8cbe';
      viabilityRating = 'Dense market - High potential but shared demand';
    } else {
      demographicColor = '#fee090';
      viabilityRating = overlapRatio >= 0.6 ? 'Dense market - Balanced demand' : 'Medium - Stable';
    }

    const demographicCircle = L.circle([store.lat, store.lng], {
      radius: demographicRadiusMeters,
      color: demographicColor,
      weight: 1.5,
      opacity: 0.88,
      fillColor: demographicColor,
      fillOpacity: 0.12,
    });

    demographicCircle.bindPopup(`
      <div style="min-width:220px">
        <strong>${operator.id}</strong><br>
        Mode: Demographic catchment radius<br>
        Nearby population (raw): ${Math.round(rawPopulationNearby).toLocaleString()}<br>
        Nearby population (balanced): ${Math.round(populationNearby).toLocaleString()}<br>
        Shared population in overlaps: ${Math.round(sharedPopulationNearby).toLocaleString()}<br>
        Overlap ratio: ${Math.round(overlapRatio * 100)}%<br>
        Allocated population after sharing: ${Math.round(allocatedPopulationNearby).toLocaleString()}<br>
        Relative size: ${Math.round(demographicRadiusMeters)} m<br>
        ${hasCompetitors ? `Competitors nearby: Yes<br>` : ''}
        ${hasOverlap ? `Overlapping stores: Yes<br>` : ''}
        <strong style="color: ${demographicColor}">Viability: ${viabilityRating}</strong>
      </div>
    `, { maxWidth: 320 });
    demographicCircle.addTo(demographicLayer);
  });

  layers.catchmentCircleLayers = {
    geographic: geographicLayer,
    demographic: demographicLayer,
  };
  state.countryLayers[countryId] = layers;

  return layers.catchmentCircleLayers;
}

function refreshCatchmentDisplay(countryId) {
  const country = MAP_DATA.countries[countryId];
  const layers = buildCountryLayers(countryId);
  const catchmentLayers = buildCatchmentLayers(countryId);
  if (!country || !layers || !catchmentLayers) return;

  removeLayer(map, layers.catchmentCircleLayers?.geographic);
  removeLayer(map, layers.catchmentCircleLayers?.demographic);

  removeLayer(map, catchmentLayers.geographic);
  removeLayer(map, catchmentLayers.demographic);

  const visibility = state.operatorVisibility[countryId] || {};
  const dtVisible = visibility[country.dtBrand] !== false;
  if (!dtVisible) return;

  addLayer(map, state.catchmentMode === 'geographic' ? catchmentLayers.geographic : catchmentLayers.demographic);
}

function applyCatchmentMode(mode) {
  state.catchmentMode = mode === 'demographic' ? 'demographic' : 'geographic';
  catchmentModeInputs.forEach((input) => {
    input.checked = input.value === state.catchmentMode;
  });
  if (state.currentCountryId) {
    refreshCatchmentDisplay(state.currentCountryId);
  }
}

function buildNearestDistanceCircles(countryId) {
  const country = MAP_DATA.countries[countryId];
  if (!country) return null;
  const layers = buildCountryLayers(countryId);
  if (!layers) return null;
  if (layers.nearestDistanceCircles) return layers.nearestDistanceCircles;

  const circles = L.layerGroup();
  (country.operators || []).forEach((operator) => {
    const operatorLayer = layers.operators[operator.id];
    if (!operatorLayer || !operatorLayer._layers) return;
    Object.values(operatorLayer._layers).forEach((marker) => {
      const nearestKm = marker.nearestStoreDistance || 0;
      if (!Number.isFinite(nearestKm) || nearestKm <= 0) return;
      const circle = L.circle(marker.getLatLng(), {
        radius: nearestKm * 1000,
        color: '#3388ff',
        weight: 1,
        opacity: 0.6,
        fillOpacity: 0.04,
      });
      circle.bindTooltip(`Nearest NatCo distance: ${nearestKm.toFixed(2)} km`, { sticky: true });
      circle._linkedMarker = marker;
      circles.addLayer(circle);
    });
  });

  layers.nearestDistanceCircles = circles;
  return circles;
}

function buildCountryLayers(countryId) {
  const country = MAP_DATA.countries[countryId];
  if (!country) return null;
  if (state.countryLayers[countryId]) return state.countryLayers[countryId];

  const heatLayer = country.heatmap && country.heatmap.length
    ? L.heatLayer(country.heatmap, {
      radius: 18,
      blur: 16,
      minOpacity: 0.18,
      maxZoom: 10,
    })
    : null;

  const catchmentLayer = country.catchment && country.catchment.features && country.catchment.features.length
    ? L.geoJSON(country.catchment, {
      style: (feature) => ({
        color: feature.properties.color_zone,
        weight: 1.5,
        opacity: 0.9,
        fillColor: feature.properties.color_zone,
        fillOpacity: 0.28,
      }),
      onEachFeature: (feature, layer) => {
        const props = feature.properties || {};
        const html = `
          <div style="min-width:210px">
            <strong>${props.nom || ''}</strong><br>
            Status: ${props.profile || ''}<br>
            Competitors: ${props.competitors ?? 0}<br>
            Own stores: ${props.own_shops ?? 0}<br>
            Est. population: ${props.pop_in_radius ?? 0}
          </div>
        `;
        layer.bindTooltip(html, { sticky: true });
      },
    })
    : null;

  const operators = {};
  // build list of all points for the selected TELEKOM_BRANDS within this country
  const telekomOperatorIds = TELEKOM_BRANDS.map(b => String(b).toLowerCase());
  const telekomPoints = [];
  (country.operators || []).forEach(op => {
    if (op.points && telekomOperatorIds.includes(String(op.id).toLowerCase())) {
      op.points.forEach(p => telekomPoints.push({ lat: p.lat, lng: p.lng, operatorId: op.id }));
    }
  });

  (country.operators || []).forEach((operator) => {
    const group = L.layerGroup();
    (operator.points || []).forEach((point) => {
      const marker = L.circleMarker([point.lat, point.lng], {
        radius: operator.id === country.dtBrand ? 6 : 4,
        color: operator.color,
        weight: 1.5,
        fillColor: operator.color,
        fillOpacity: 0.92,
      });
      marker.operatorId = operator.id;
      // compute nearest distance among the selected TELEKOM_BRANDS' points (country-local)
      let nearestKm = 0;
      if (isTelekomBrandName(operator.id) && telekomPoints.length) {
        nearestKm = telekomPoints.reduce((min, p) => {
          if (p.lat === point.lat && p.lng === point.lng) return min; // skip same store
          const d = haversineKm(point.lat, point.lng, p.lat, p.lng);
          return Math.min(min, d);
        }, Infinity);
        if (!Number.isFinite(nearestKm) || nearestKm === Infinity) nearestKm = 0;
      }
      marker.nearestStoreDistance = Number((nearestKm || 0));
      marker.bindPopup(point.popup, { maxWidth: 320 });
      marker.addTo(group);
    });
    operators[operator.id] = group;
  });

  const layers = {
    heatLayer,
    catchmentLayer,
    catchmentCircleLayers: null,
    operators,
    bounds: country.bounds,
  };

  state.countryLayers[countryId] = layers;
  return layers;
}

function hideCountry(countryId) {
  const layers = buildCountryLayers(countryId);
  if (!layers) return;
  removeLayer(map, layers.heatLayer);
  removeLayer(map, layers.catchmentLayer);
  removeLayer(map, layers.catchmentCircleLayers?.geographic);
  removeLayer(map, layers.catchmentCircleLayers?.demographic);
  Object.values(layers.operators).forEach((layer) => removeLayer(map, layer));
}

function showCountry(countryId) {
  const country = MAP_DATA.countries[countryId];
  const layers = buildCountryLayers(countryId);
  if (!country || !layers) return;

  // Only add catchment geojson and related visuals when nearest-filter is NOT active
  if (!state.nearestFilterEnabled) {
    addLayer(map, layers.catchmentLayer);

    const heatVisible = state.heatmapVisibility[countryId] === true;
    setLayerVisible(layers.heatLayer, heatVisible);
    if (heatmapToggle) {
      heatmapToggle.checked = heatVisible;
    }

    refreshCatchmentDisplay(countryId);
  } else {
    // When nearest filter is active, ensure catchment visuals are removed
    removeLayer(map, layers.catchmentLayer);
    removeLayer(map, layers.catchmentCircleLayers?.geographic);
    removeLayer(map, layers.catchmentCircleLayers?.demographic);
    // Also hide heatmap to avoid visual clutter
    removeLayer(map, layers.heatLayer);
    if (heatmapToggle) heatmapToggle.checked = false;
  }

  const visibility = state.operatorVisibility[countryId] || {};
  (country.operators || []).forEach((operator) => {
    const visible = visibility[operator.id] !== false;
    setLayerVisible(layers.operators[operator.id], visible);
    visibility[operator.id] = visible;
  });
  state.operatorVisibility[countryId] = visibility;

  const dtVisible = visibility[country.dtBrand] !== false;
  if (!dtVisible) {
    removeLayer(map, layers.catchmentCircleLayers?.geographic);
    removeLayer(map, layers.catchmentCircleLayers?.demographic);
  }

  if (layers.bounds && layers.bounds.length === 4) {
    const bounds = L.latLngBounds([
      [layers.bounds[0], layers.bounds[1]],
      [layers.bounds[2], layers.bounds[3]],
    ]);
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.08));
    }
  }
  // Re-apply filter view state when showing a country
  applyFilterView(countryId);
}

function renderOperatorList(countryId) {
  const country = MAP_DATA.countries[countryId];
  const layers = buildCountryLayers(countryId);
  if (!country || !layers) return;

  operatorContainer.innerHTML = '';
  const visibility = state.operatorVisibility[countryId] || {};

  (country.operators || []).forEach((operator) => {
    if (visibility[operator.id] === undefined) {
      visibility[operator.id] = true;
    }

    const row = document.createElement('label');
    row.className = 'operator-item';
    row.innerHTML = `
      <span>
        <span class="operator-dot" style="background:${operator.color}"></span>
        <span>${operator.id}</span>
      </span>
      <input type="checkbox" data-operator="${operator.id}" ${visibility[operator.id] ? 'checked' : ''} />
    `;

    const checkbox = row.querySelector('input');
    checkbox.addEventListener('change', () => {
      visibility[operator.id] = checkbox.checked;
      setLayerVisible(layers.operators[operator.id], checkbox.checked);
      if (operator.id === country.dtBrand) {
        refreshCatchmentDisplay(countryId);
      }
      applyFilterView(countryId);
    });

    operatorContainer.appendChild(row);
  });

  state.operatorVisibility[countryId] = visibility;
}

function setCountry(countryId) {
  if (!countryId || countryId === state.currentCountryId) return;

  if (state.currentCountryId) {
    hideCountry(state.currentCountryId);
  }

  state.currentCountryId = countryId;
  renderOperatorList(countryId);
  showCountry(countryId);
}

function initHeatmapToggle() {
  if (!heatmapToggle) return;

  heatmapToggle.checked = false;
  heatmapToggle.addEventListener('change', () => {
    if (!state.currentCountryId) return;
    const layers = buildCountryLayers(state.currentCountryId);
    if (!layers) return;

    const visible = heatmapToggle.checked;
    state.heatmapVisibility[state.currentCountryId] = visible;
    setLayerVisible(layers.heatLayer, visible);
  });
}

function initCatchmentModeSelect() {
  if (!catchmentModeInputs.length) return;

  catchmentModeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) {
        applyCatchmentMode(input.value);
      }
    });
  });
}

function applyNearestFilter(countryId) {
  // kept for backward compatibility; delegate to applyFilterView
  applyFilterView(countryId);
}

function applyFilterView(countryId) {
  if (!countryId) return;
  const country = MAP_DATA.countries[countryId];
  if (!country) return;
  const layers = buildCountryLayers(countryId);
  if (!layers) return;

  const view = state.filterView;
  // ensure we remove existing special layers first
  removeLayer(map, layers.nearestDistanceCircles);
  removeLayer(map, layers.catchmentLayer);
  removeLayer(map, layers.catchmentCircleLayers?.geographic);
  removeLayer(map, layers.catchmentCircleLayers?.demographic);

  if (view === 'none') {
    // show only operator points and optionally heatmap
    const heatVisible = state.heatmapVisibility[countryId] === true;
    setLayerVisible(layers.heatLayer, heatVisible);
    if (heatmapToggle) heatmapToggle.checked = heatVisible;
    state.nearestFilterEnabled = false;
    return;
  }

  if (view === 'catchment') {
    // show catchment visuals and heatmap according to settings
    state.nearestFilterEnabled = false;
    const heatVisible = state.heatmapVisibility[countryId] === true;
    setLayerVisible(layers.heatLayer, heatVisible);
    if (heatmapToggle) heatmapToggle.checked = heatVisible;
    refreshCatchmentDisplay(countryId);
    return;
  }

  if (view === 'nearest') {
    // hide catchment visuals and heatmap, show nearest-distance circles
    state.nearestFilterEnabled = true;
    removeLayer(map, layers.heatLayer);
    if (heatmapToggle) heatmapToggle.checked = false;
    const circles = buildNearestDistanceCircles(countryId);
    if (circles) {
      layers.nearestDistanceCircles = circles;
      addLayer(map, layers.nearestDistanceCircles);
    }
    return;
  }
}

function initFilterView() {
  if (!filterViewInputs.length) return;
  filterViewInputs.forEach((input) => {
    input.checked = input.value === state.filterView;
    input.addEventListener('change', () => {
      if (input.checked) {
        state.filterView = input.value;
        applyFilterView(state.currentCountryId);
      }
    });
  });
}



function initMenu() {
  countrySelect.innerHTML = '';
  countryOrder.forEach((countryId) => {
    const country = MAP_DATA.countries[countryId];
    if (!country) return;

    const option = document.createElement('option');
    option.value = countryId;
    option.textContent = `${country.flag} ${country.name}`;
    countrySelect.appendChild(option);
  });

  countrySelect.addEventListener('change', () => setCountry(countrySelect.value));
}

function init() {
  initMenu();
  initHeatmapToggle();
  initCatchmentModeSelect();
  initFilterView();
  applyCatchmentMode(state.catchmentMode);
  const defaultCountry = countryOrder[0];
  countrySelect.value = defaultCountry;
  setCountry(defaultCountry);
}

if (window.MAP_DATA) {
  init();
} else {
  console.error('MAP_DATA is missing. Run build_map.py first.');
}
