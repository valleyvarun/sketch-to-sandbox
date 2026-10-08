function createStationSearch(input, list, stations, stationValue, onChange) {
  let matches = [];
  let activeIndex = -1;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  function position() {
    if (list.hidden) return;
    const rect = input.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const openBelow = below >= 120 || below >= above;
    list.style.left = `${rect.left}px`;
    list.style.width = `${rect.width}px`;
    list.style.top = openBelow ? `${rect.bottom + 4}px` : 'auto';
    list.style.bottom = openBelow ? 'auto' : `${window.innerHeight - rect.top + 4}px`;
    list.style.maxHeight = `${Math.max(40, Math.min(200, openBelow ? below : above))}px`;
  }

  function choose(station) {
    input.value = stationValue(station);
    onChange();
    close();
  }

  function render() {
    const value = input.value.trim().toLowerCase();
    const selected = stations.find(station => stationValue(station).toLowerCase() === value);
    const query = selected ? selected.properties.name.toLowerCase() : value;
    matches = stations.filter(station => station.properties.name.toLowerCase().includes(query));
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    list.replaceChildren();
    for (const station of matches) {
      const option = document.createElement('div');
      option.id = `${input.id}-option-${station.properties.id}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.textContent = stationValue(station);
      option.addEventListener('click', () => choose(station));
      list.appendChild(option);
    }
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.setAttribute('role', 'status');
      empty.textContent = 'No matching stations';
      list.appendChild(empty);
    }
    list.hidden = false;
    list.scrollTop = 0;
    input.setAttribute('aria-expanded', 'true');
    position();
  }

  input.addEventListener('focus', render);
  input.addEventListener('click', render);
  input.addEventListener('input', () => {
    onChange();
    render();
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) render();
      if (!matches.length) return;
      activeIndex = event.key === 'ArrowDown' ?
        (activeIndex + 1) % matches.length :
        (activeIndex <= 0 ? matches.length : activeIndex) - 1;
      Array.from(list.children).forEach((option, i) =>
        option.setAttribute('aria-selected', String(i === activeIndex)));
      const option = list.children[activeIndex];
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault();
      if (activeIndex >= 0) choose(matches[activeIndex]);
      else if (matches.length === 1) choose(matches[0]);
    }
  });

  // Keep input focus while clicking a result or using the dropdown scrollbar.
  list.addEventListener('pointerdown', event => event.preventDefault());
  function outsidePointer(event) {
    if (event.target !== input && !list.contains(event.target)) close();
  }
  function outsideFocus(event) {
    if (event.target !== input && !list.contains(event.target)) close();
  }
  document.addEventListener('pointerdown', outsidePointer);
  document.addEventListener('focusin', outsideFocus);
  document.addEventListener('scroll', position, true);
  window.addEventListener('resize', position);
  return {
    close,
    refresh() {
      if (!list.hidden) render();
    },
    destroy() {
      close();
      document.removeEventListener('pointerdown', outsidePointer);
      document.removeEventListener('focusin', outsideFocus);
      document.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    }
  };
}
