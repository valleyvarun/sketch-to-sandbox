function setupSidebarResize(onResize) {
  const layout = document.getElementById('mainLayout');
  const handle = document.getElementById('sidebarResize');
  const minimum = 300;
  let width = minimum;
  let drag = null;

  function maximum() {
    return Math.max(minimum, layout.clientWidth - 300 - 200);
  }

  function update(value) {
    width = Math.max(minimum, Math.min(maximum(), value));
    layout.style.setProperty('--right-sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(width));
    onResize();
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus();
    drag = { id: event.pointerId, x: event.clientX, width };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (drag && drag.id === event.pointerId) update(drag.width + drag.x - event.clientX);
  });
  function finish(event) {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('keydown', event => {
    let value;
    if (event.key === 'ArrowLeft') value = width + 20;
    else if (event.key === 'ArrowRight') value = width - 20;
    else if (event.key === 'Home') value = minimum;
    else if (event.key === 'End') value = maximum();
    else return;
    event.preventDefault();
    update(value);
  });
  window.addEventListener('resize', () => update(width));
  update(width);
}
